/**
 * PiRpcClient — spawns a headless `pi --mode rpc` process and speaks the
 * JSONL protocol on stdin/stdout.
 *
 * Commands are JSON objects on stdin; responses and agent events are JSON
 * lines on stdout. Responses carry the caller's `id` for correlation; events
 * are streamed as they occur (see `AgentSessionEvent` in
 * `@earendil-works/pi-coding-agent`).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'

/** Minimal structural types mirroring Pi's RPC surface (kept local to avoid a hard dependency on pi packages). */

export interface PiCommand {
  id?: string
  type: string
  [key: string]: unknown
}

export interface PiResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/** The event envelope Pi streams on stdout during a run. */
export interface PiEvent {
  type: string
  [key: string]: unknown
}

export interface PiRpcClientOptions {
  /** Pi executable; defaults to `pi` resolved from PATH. */
  piPath?: string
  /** Working directory for the Pi agent session. */
  cwd: string
  /** Initial model route (`provider/model`), e.g. `anthropic/claude-sonnet-4-5`. */
  model?: string
  /** Abort signal that kills the child process. */
  signal?: AbortSignal
  /** Log sink for protocol diagnostics. */
  logger?: (line: string) => void
}

export class PiRpcClient {
  readonly cwd: string
  private readonly proc: ChildProcess
  private readonly events = new EventEmitter()
  private readonly pending = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private closed = false
  private nextId = 0
  private readonly logger?: (line: string) => void

  constructor(options: PiRpcClientOptions) {
    this.cwd = resolve(options.cwd)
    this.logger = options.logger
    const piPath = options.piPath ?? 'pi'
    const args = ['--mode', 'rpc', '--no-session']
    this.proc = spawn(piPath, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (chunk: string) => this.logger?.(`[pi:stderr] ${chunk.trimEnd()}`))
    this.proc.on('error', (error) => this.logger?.(`[pi:error] ${String(error)}`))
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      this.logger?.(`[pi:exit] code=${String(code)} signal=${String(signal)}`)
      const failure = new Error(`pi process exited (code=${String(code)} signal=${String(signal)})`)
      for (const entry of this.pending.values()) entry.reject(failure)
      this.pending.clear()
      this.events.emit('exit', { code, signal })
    })
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        if (!this.closed) this.proc.kill('SIGTERM')
      }, { once: true })
    }
    if (options.model) {
      void this.send({ type: 'set_model', provider: options.model.split('/')[0], modelId: options.model.split('/').slice(1).join('/') })
        // Teardown can kill the child before this command's response arrives;
        // without a handler the rejection becomes an unhandled rejection that
        // crashes the host process.
        .catch(() => undefined)
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.logger?.(`[pi:bad-json] ${line.slice(0, 200)}`)
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    if (record.type === 'response') {
      const response = message as PiResponse
      const id = response.id ?? response.command
      if (id === undefined) return
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      entry.resolve(response)
      return
    }
    this.logger?.(`[pi:event] ${String(record.type)}`)
    this.events.emit('event', message)
  }

  /**
   * Send one command and await its correlated response.
   * @returns the response envelope (success or failure).
   */
  send(command: PiCommand): Promise<PiResponse> {
    if (this.closed) return Promise.reject(new Error('pi process is not running'))
    const id = command.id ?? `cmd-${++this.nextId}`
    const framed = { ...command, id }
    return new Promise<PiResponse>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      const line = JSON.stringify(framed)
      this.logger?.(`[pi:cmd] ${line.slice(0, 200)}`)
      this.proc.stdin!.write(`${line}\n`, (error) => {
        if (error) {
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  /** Send a prompt and await the terminal `response` (run completion signal). */
  async prompt(message: string): Promise<void> {
    const response = await this.send({ type: 'prompt', message })
    if (!response.success) throw new Error(`pi prompt failed: ${response.error ?? 'unknown error'}`)
  }

  /** Abort the active run. */
  async abort(): Promise<void> {
    try {
      await this.send({ type: 'abort' })
    } catch {
      // process may already be gone
    }
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  onEvent(listener: (event: PiEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  /** Resolves when the child process exits. */
  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    this.events.on('exit', listener)
    return () => this.events.off('exit', listener)
  }

  get running(): boolean {
    return !this.closed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
}
