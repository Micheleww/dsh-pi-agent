/**
 * History handoff — bridge a DSH session's durable event log into a Pi
 * session file.
 *
 * The Pi child processes we spawn (`pi --mode rpc`) normally start with an
 * empty context: the bridge translates new turns as they arrive, but nothing
 * tells the child what happened BEFORE it took over. That is fine for a
 * session born under Pi, and it is the gap this module closes for
 * mid-session handoff: a session that already ran turns under DSH's own
 * loop (or under an earlier Pi child) is rebuilt as a Pi v3 session file, so
 * the new child resumes with the full conversation in its context window.
 *
 * DSH is the durable source of truth. Every turn — DSH-native or Pi-driven —
 * lands in the session's event log (`user/message`, `assistant/message`,
 * `tool/call`, `tool/result`). Each `create`/`resume` rebuilds the Pi file
 * from that log, so the child always sees the complete history regardless of
 * which engine produced any given turn.
 *
 * Pi session files are JSONL, one entry per line:
 *
 *   {"type":"session","version":3,"id":"uuid","timestamp":"…","cwd":"…"}
 *   {"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"…","message":{…}}
 *
 * The v3 shape is what `pi --session <file>` loads natively (auto-migrated to
 * the current internal version on open). DSH message blocks map to Pi blocks
 * as follows:
 *
 *   dsh text          → pi text
 *   dsh reasoning     → pi thinking
 *   dsh tool-call     → pi toolCall  (arguments JSON string re-parsed)
 *   dsh image         → skipped (attachment refs need the attachment service)
 *   dsh tool-result   → pi toolResult (tool name recovered from the call log)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AssistantMessage,
  ContentBlock,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** Pi v3 session file entry shapes (structural mirror, no pi dependency). */
export interface PiSessionHeader {
  type: 'session'
  version: 3
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

interface PiTextBlock { type: 'text'; text: string }
interface PiThinkingBlock { type: 'thinking'; thinking: string }
interface PiToolCallBlock { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

/** Pi user content may be a bare string; assistant/toolResult content is blocks. */
type PiUserContent = string | Array<PiTextBlock | PiThinkingBlock>
type PiAssistantContent = Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock>

export interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: string | Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock>
  /** assistant-only */
  provider?: string
  model?: string
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  /** toolResult-only */
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface PiMessageEntry {
  type: 'message'
  id: string
  parentId: string | null
  timestamp: string
  message: PiMessage
}

export interface BuildPiSessionFileOptions {
  /** DSH session whose event log is the history source. */
  session: Session
  /** Working directory recorded on the Pi session header. */
  cwd: string
  /** Destination file path for the Pi session. */
  filePath: string
  /** Diagnostics sink. */
  logger?: (line: string) => void
}

/** Map a DSH finish reason to the Pi stopReason vocabulary. */
function mapStopReason(reason: { kind: string } | undefined, hasToolCalls: boolean): PiMessage['stopReason'] {
  if (hasToolCalls) return 'toolUse'
  switch (reason?.kind) {
    case 'max-tokens': return 'length'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    default: return 'stop'
  }
}

/** Convert one DSH content block to Pi blocks; returns [] when skipped. */
function convertBlocks(blocks: readonly ContentBlock[], logger?: (line: string) => void): Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock> {
  const out: Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock> = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        out.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        let argumentsRecord: Record<string, unknown> = {}
        if (block.arguments !== '') {
          try {
            const parsed: unknown = JSON.parse(block.arguments)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              argumentsRecord = parsed as Record<string, unknown>
            }
          } catch {
            argumentsRecord = { raw: block.arguments }
          }
        }
        out.push({ type: 'toolCall', id: String(block.id), name: block.name, arguments: argumentsRecord })
        break
      }
      case 'image':
        // Attachment refs resolve through the attachment service at run time;
        // the rebuild path has no such handle. Text history carries context;
        // images are dropped with a notice.
        logger?.(`[history] skipping image block (attachment ref)`)
        break
      default:
        break
    }
  }
  return out
}

/** Convert a DSH user message to the Pi user message shape. */
function toPiUserMessage(message: UserMessage, logger?: (line: string) => void): PiMessage {
  const blocks = convertBlocks(message.content, logger)
  const text = blocks
    .filter((block): block is PiTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  // Pure-text user input takes the compact string form pi writes itself.
  return { role: 'user', content: text === '' ? blocks : text }
}

/** Convert a DSH assistant message to the Pi assistant message shape. */
function toPiAssistantMessage(
  event: SessionEvent<'assistant/message'>,
  finishReasons: ReadonlyMap<number, { kind: string }>,
  logger?: (line: string) => void,
): PiMessage | undefined {
  const message = event.data.message as AssistantMessage
  const blocks = convertBlocks(message.content, logger)
  if (blocks.length === 0) return undefined
  const hasToolCalls = blocks.some((block) => block.type === 'toolCall')
  const source = message.source as { kind?: string; provider?: string; model?: string } | undefined
  return {
    role: 'assistant',
    content: blocks,
    ...(source?.provider !== undefined ? { provider: source.provider } : {}),
    ...(source?.model !== undefined ? { model: source.model } : {}),
    stopReason: mapStopReason(finishReasons.get(event.data.turn), hasToolCalls),
  }
}

/** Convert a DSH tool result to the Pi toolResult message shape. */
function toPiToolResultMessage(
  event: SessionEvent<'tool/result'>,
  toolNames: ReadonlyMap<string, string>,
  logger?: (line: string) => void,
): PiMessage {
  const message = event.data.message as ToolResultMessage
  const block = message.content[0]
  const callId = String(block?.toolCallId ?? '')
  const content = convertBlocks(block?.content ?? [], logger)
  return {
    role: 'toolResult',
    content,
    toolCallId: callId,
    toolName: toolNames.get(callId) ?? 'unknown',
    isError: block?.isError === true,
  }
}

/** Deterministic 8-char hex entry id from the source event seq. */
function entryId(seq: number): string {
  return `e${seq.toString(16).padStart(7, '0')}`
}

/**
 * Rebuild a Pi v3 session file from a DSH session's event log.
 *
 * @returns the written file path (the `filePath` argument).
 */
export function buildPiSessionFile(options: BuildPiSessionFileOptions): string {
  const { session, cwd, filePath, logger } = options

  const toolNames = new Map<string, string>()
  const finishReasons = new Map<number, { kind: string }>()
  const entries: PiMessageEntry[] = []
  let parentId: string | null = null

  for (const event of session.events) {
    switch (event.type) {
      case 'turn/end': {
        const reason = event.data.reason
        finishReasons.set(event.data.turn, reason as { kind: string })
        break
      }
      case 'tool/call':
        toolNames.set(String(event.data.callId), event.data.name)
        break
      case 'user/message': {
        const message = toPiUserMessage(event.data as UserMessage, logger)
        const id = entryId(event.seq)
        entries.push({ type: 'message', id, parentId, timestamp: new Date(event.time).toISOString(), message })
        parentId = id
        break
      }
      case 'assistant/message': {
        const message = toPiAssistantMessage(event, finishReasons, logger)
        if (message === undefined) break
        const id = entryId(event.seq)
        entries.push({ type: 'message', id, parentId, timestamp: new Date(event.time).toISOString(), message })
        parentId = id
        break
      }
      case 'tool/result': {
        const message = toPiToolResultMessage(event, toolNames, logger)
        const id = entryId(event.seq)
        entries.push({ type: 'message', id, parentId, timestamp: new Date(event.time).toISOString(), message })
        parentId = id
        break
      }
      default:
        break
    }
  }

  const header: PiSessionHeader = {
    type: 'session',
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  }
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))]
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`)
  logger?.(`[history] wrote ${entries.length} message entries to ${filePath}`)
  return filePath
}
