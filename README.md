# dsh-pi-agent

Run the [Pi coding agent](https://github.com/earendil-works/pi) loop inside [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): a DSH `Agent` plugin that drives a headless `pi --mode rpc` child process, so DSH's frontend — session log, hooks, presets, UI — works unchanged.

```
DSH frontend (sessions, hooks, presets, SQLite persistence, UI)
        │
dsh-pi-agent  (this plugin: AgentFactory + event translation)
        │  spawn + JSONL over stdio
        │  commands: set_model / prompt / steer / abort
        ▼
pi --mode rpc --no-session   (the Pi agent loop, untouched)
```

## Why

Pi is a minimal harness: a ~300-token system prompt, four tools (`read`/`bash`/`edit`/`write`), and zero mid-session injections. DSH is a plugin-based platform: durable sessions, policies, approval chains, and a full prompt-assembly registry.

This plugin gives you both at once: **DSH's engineering shell around Pi's clean engine.** When the plugin is active, the model sees exactly what it would see running `pi` directly in the same working directory — no extra prompt sections, no extra tools, no hidden reminders. DSH's own prompt assembly (`dsh-system-prompt`) and tool surface are bypassed entirely for sessions driven by this factory.

It also makes a clean A/B experiment: same frontend, same session format, switch the plugin on/off to compare DSH's native loop against the bare Pi loop.

## What changes vs. what doesn't

| Layer | Behavior |
| --- | --- |
| System prompt / tools / context | **Untouched** — identical to running `pi` in the same directory (context files like `AGENTS.md` are loaded by Pi itself) |
| Model routing | `set_model` per session; a delegated subagent's requested model wins over the factory default |
| Steering | DSH `send(..., 'next-turn' \| 'next-step')` maps to Pi's `steer` — inject instructions mid-run |
| Session persistence | Pi runs with `--no-session`; durability comes from DSH's session events (`turn/*`, `step/*`, `tool/call`, ...) |
| Approval / permissions | Pi's local-trust model applies — Pi tool calls do not pass through DSH's approval chain |
| Fallback | Disable this plugin's entry and DSH's own `dsh-agent-loop` becomes active again immediately |

## Requirements

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) on `PATH` (or pass `piPath`)
- A DSH profile with `sessions` and `agents` services (the standard frontend assembly)
- Peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`

## Install

```bash
npm install dsh-pi-agent
```

The package is on the npm registry ([dsh-pi-agent](https://www.npmjs.com/package/dsh-pi-agent)). Mount it from any DSH profile (see [dsh-pi](https://github.com/Micheleww/dsh-pi) for a ready-made web profile).

## Usage

Mount in the profile patch layer (`cordis.patch.yml`):

```yaml
# Use the Pi loop for all new sessions.
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
      config:
        piPath: 'pi'                      # or an absolute path
        cwd: '/path/to/your/project'      # working directory for Pi sessions
        model: 'anthropic/claude-sonnet-4-5'  # provider/model route
        debug: false

# Fall back to DSH's own loop: disable this entry and re-enable agent-loop.
# - id: pi-agent
#   disabled: true
```

### Config

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Pi executable; resolved from `PATH` |
| `cwd` | `string` | `process.cwd()` | Working directory for Pi sessions |
| `model` | `string` | — | Pi model route (`provider/model`) |
| `debug` | `boolean` | `false` | Append protocol diagnostics to `/tmp/dsh-pi-agent.log` |

## Debugging

Set `debug: true` (or mount with a `logger`): every RPC command, event, child-process exit, and factory lifecycle step is appended to `/tmp/dsh-pi-agent.log`. Pi's own stderr is forwarded into the same log.

## License

MIT
