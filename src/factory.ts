/**
 * PiAgentFactory — the `AgentFactory` (`ctx.agents.setFactory`) that turns
 * DSH's frontend into a client for the Pi coding agent loop.
 *
 * When this plugin is loaded, every new session the frontend creates is
 * driven by a Pi child process (`pi --mode rpc`) instead of DSH's own
 * `dsh-agent-loop`. The factory mints the session, the scoped PiAgent, and
 * the Pi RPC child, then publishes both through the same ordered boundary the
 * default loop uses (`session/created`, `agent/created`,
 * `agent/session-start`), so DSH's frontend, hooks, and session log work
 * unchanged.
 *
 * To fall back to DSH's own loop, disable this plugin's entry (or the
 * profile patch inserting it) — the default `agent-loop` factory remains
 * registered underneath and becomes active again.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  emitAgentEvent,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { createScope, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { PiAgent } from './pi-agent.ts'
import { PiRpcClient } from './rpc-client.ts'

export interface PiFactoryOptions {
  /** Absolute path to the Pi executable (defaults to `pi` on PATH). */
  piPath?: string
  /** Working directory for Pi sessions (defaults to process.cwd()). */
  cwd: string
  /** Pi model route (`provider/model`, e.g. `anthropic/claude-sonnet-4-5`). */
  model?: string
  /** Diagnostics sink; omit to keep quiet. */
  logger?: (line: string) => void
  /** Lifecycle trace sink (apply/createAgent/resume); omit to keep quiet. */
  trace?: (line: string) => void
}

export class PiAgentFactory implements AgentFactory {
  private readonly registryCtx: Context

  constructor(
    private readonly options: PiFactoryOptions,
    registryCtx: Context,
  ) {
    this.registryCtx = registryCtx
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const id = options.sessionId
    this.options.trace?.(`createAgent id=${String(id)} meta=${JSON.stringify(options.meta)}`)
    const cwd = options.meta?.cwd ?? this.options.cwd
    try {
      const session = this.registryCtx.sessions.prepare(id, {
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.seed === undefined ? {} : { seed: options.seed },
      })
        const handle = await this.assembleAndPublish(ownerCtx, id, session, cwd, options.agentOptions, options.signal, options.setup)
      this.options.trace?.(`createAgent OK id=${String(id)}`)
      return handle
    } catch (error: unknown) {
      this.options.trace?.(`createAgent FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    this.options.trace?.(`resume id=${String(id)}`)
    try {
      const preparation = await persistence.prepare(id)
      try {
        const session = preparation.session
        const cwd = session.header.cwd ?? this.options.cwd
      const handle = await this.assembleAndPublish(ownerCtx, id, session, cwd, options.agentOptions, options.signal, options.setup)
        this.options.trace?.(`resume OK id=${String(id)}`)
        return handle
      } finally {
        preparation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      this.options.trace?.(`resume FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  /** Mint the Pi RPC child, build the scoped PiAgent, and publish the pair. */
  private async assembleAndPublish(
    ownerCtx: Context,
    id: SessionId,
    session: Session,
    cwd: string,
    agentOptions: AgentOptions | undefined,
    signal: AbortSignal | undefined,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive()
    if (signal?.aborted) throw new Error(`agent "${id}" creation aborted`)

    this.options.trace?.(`dsh-scope resolved at: ${import.meta.resolve('@deepseek-ai/dsh-scope')}`)
    // The requested per-agent model route wins over the factory default. This
    // is what lets a delegated child (whose `agentOptions` come from
    // tool-subagent's config) run on a fixed model like `provider/model`
    // while the top-level session keeps the factory default.
    const requested = agentOptions
    const model = requested?.model !== undefined && requested.model !== ''
      ? `${requested.provider ?? ''}/${requested.model}`.replace(/^\/+/, '')
      : this.options.model ?? ''
    const provider = model.split('/')[0] ?? ''
    const modelId = model.split('/').slice(1).join('/')

    const scope = createScope(this.registryCtx, id as unknown as ScopeKey)
    const rpc = new PiRpcClient({
      cwd,
      model: model === '' ? undefined : model,
      piPath: this.options.piPath,
      logger: this.options.logger,
    })
    const agent = new PiAgent({
      ctx: this.registryCtx,
      session,
      agentOptions: {
        ...agentOptions,
        // Only fill route fields the caller did not provide.
        ...(provider !== '' && requested?.provider === undefined ? { provider } : {}),
        ...(modelId !== '' && requested?.model === undefined ? { model: modelId } : {}),
      },
      rpc,
      cwd,
    })

    // Creation-window composition (the AgentFactory contract): await the
    // caller's setup on the agent's scoped context, invoke its synchronous
    // commit if any, and only then insert/announce — so no observer can see a
    // partially configured child world. Setup composes, it never drives. It
    // runs inside the try below so a rejection rolls the child back through
    // the same dispose path (agent, rpc child, scope).
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      try {
        agent.dispose()
        rpc.close()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          // PiAgent.dispose() already unwinds its own scope.
        }
      }
    })())
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing !== undefined) return
      void dispose()
    })

    try {
      if (setup !== undefined) {
        try {
          const setupCommit = await setup(agent.ctx)
          setupCommit?.commit()
        } catch (error: unknown) {
          this.options.trace?.(`setup FAILED id=${String(id)}: ${String(error)}`)
          throw error
        }
      }
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.registryCtx.agents.enter(agent, ownerCtx.agent)
      agent.ctx.sessions.announce(session)
      this.registryCtx.agents.announce(agent)
      emitAgentEvent(this.registryCtx, agent, 'agent/session-start', { source: 'startup' })
      return { agent, dispose: () => dispose().then(() => undefined) }
    } catch (error: unknown) {
      unfollowOwner?.()
      await dispose()
      throw error
    }
  }
}
