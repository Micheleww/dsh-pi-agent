/**
 * dsh-pi-agent — DeepSeek Harness plugin that runs the Pi coding agent loop
 * inside DSH's frontend.
 *
 * The plugin registers an `AgentFactory` through `ctx.agents.setFactory`, so
 * every new session the frontend creates is driven by a headless
 * `pi --mode rpc` child process instead of DSH's own `dsh-agent-loop`.
 *
 * Pluggable by configuration: the default loop stays registered underneath;
 * disable this plugin's entry (or remove the profile patch that inserts it)
 * and DSH's own loop is active again immediately.
 *
 * Mount in the profile patch layer (cordis.patch.yml):
 *
 * ```yaml
 * # Use the Pi loop for all new sessions.
 * - insert:
 *     - id: pi-agent
 *       name: 'dsh-pi-agent'
 *       config:
 *         piPath: 'pi'                      # or an absolute path
 *         cwd: '/path/to/your/project'
 *         model: 'provider/model'           # e.g. anthropic/claude-sonnet-4-5
 * # Fall back to DSH's own loop: disable this entry and re-enable agent-loop.
 * # - id: pi-agent
 * #   disabled: true
 * ```
 */

import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PiAgentFactory } from './factory.ts'

export { buildPiSessionFile } from './history.ts'
export type {
  BuildPiSessionFileOptions,
  PiMessage,
  PiMessageEntry,
  PiSessionHeader,
} from './history.ts'

export const name = 'pi-agent'

export const inject = ['sessions', 'agents']

export interface Config {
  /** Pi executable; defaults to `pi` on PATH. */
  piPath?: string
  /** Working directory for Pi sessions. Defaults to process.cwd(). */
  cwd?: string
  /** Pi model route (`provider/model`, e.g. `anthropic/claude-sonnet-4-5`). */
  model?: string
  /** Protocol diagnostics; written to /tmp/dsh-pi-agent.log. */
  debug?: boolean
}

export const Config = z.object({
  piPath: z.string(),
  cwd: z.string(),
  model: z.string(),
  debug: z.boolean(),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config): void {
  const trace = (line: string): void => {
    try {
      appendFileSync('/tmp/dsh-pi-agent.log', `${new Date().toISOString()} ${line}\n`)
    } catch { /* diagnostics must never break the plugin */ }
  }
  trace(`apply entered config=${JSON.stringify(config)}`)
  try {
    const cwd = config.cwd ?? process.cwd()
    const logger = (line: string): void => {
      trace(`[pi] ${line}`)
    }
    const factory = new PiAgentFactory({ piPath: config.piPath, cwd, model: config.model, logger, trace }, ctx)
    ctx.agents.setFactory(factory)
    trace('factory registered (pi loop active)')
  } catch (error: unknown) {
    trace(`apply failed: ${String(error)}`)
    throw error
  }
}

// Re-export the subagent provider entry under a distinct subpath:
// a profile mounts it as `dsh-pi-agent/subagent` so the loop plugin and the
// delegation provider stay independently toggleable rows.
export {
  name as subagentName,
  inject as subagentInject,
  Config as SubagentConfig,
  apply as subagentApply,
} from './subagent.ts'
export type { Config as SubagentPluginConfig } from './subagent.ts'
