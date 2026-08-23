# dsh-pi-agent

把 [Pi coding agent](https://github.com/earendil-works/pi)（npm 包 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）作为 agent loop 跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（npm 包 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)）里：一个 DSH `Agent` 插件，驱动无头模式的 `pi --mode rpc` 子进程，DSH 前端（会话日志、hooks、preset、Web UI）无需任何改动即可使用。

> **在找以下任何一个？**
> - *“怎么在 DeepSeek Harness / DSH 里用 pi？”* —— 来对地方了。
> - *“把 DSH 的 agent-loop 换成 pi coding agent 的 loop？”* —— 本插件用 `pi --mode rpc` 子进程替换工厂。
> - *“给 pi 配一个 Web UI / 浏览器前端？”* —— dsh-pi-agent + 官方 DSH web app 给 pi 完整的 Web 界面：会话持久化、hooks、preset、模型切换。
> - *“在 DSH 里用极简纯净的提示词？”* —— pi 引擎保持 ~300 token 系统提示词和四工具，DSH 的提示词组装永远到不了模型面前。零提示词注入。
> - *“DSH 里能不能像接 Claude Code / Codex 那样接 pi？”* —— 可以，本插件就是把 pi 加为同等的引擎选项。

```
DSH 前端（会话、hooks、preset、SQLite 持久化、Web UI）
        │
dsh-pi-agent（本插件：AgentFactory + 事件翻译）
        │  spawn 子进程 + stdio 上的 JSONL 协议
        │  命令：set_model / prompt / steer / abort
        ▼
pi --mode rpc --no-session（原汁原味的 Pi agent loop）
```

## 为什么

Pi 是一个极简 harness：~300 token 的系统提示词、四个工具（`read`/`bash`/`edit`/`write`）、会话中途零注入。DSH 是一个插件化平台：持久会话、策略、审批链和完整的提示词组装注册表。

本插件让你同时拥有两者：**DSH 的工程外壳 + Pi 的纯净内核**。插件激活时，模型看到的内容与在同一目录直接运行 `pi` 完全一致——没有额外的提示词段落、没有额外的工具、没有隐藏的 reminder。DSH 自己的提示词组装（`dsh-system-prompt`）和工具面在由此工厂驱动的会话中被完全绕过。

它同时是一个干净的 A/B 实验：同一前端、同一会话格式，开关本插件即可对比 DSH 原生 loop 与裸 Pi loop 的表现。

## 改变与不改变

| 层面 | 行为 |
| --- | --- |
| 系统提示词 / 工具 / 上下文 | **原封不动**——与在同一目录运行 `pi` 完全一致（`AGENTS.md` 等上下文文件由 Pi 自行加载） |
| 模型路由 | 每会话 `set_model`；被委派的 subagent 请求的模型优先于工厂默认值 |
| 转向（steering） | DSH 的 `send(..., 'next-turn' \| 'next-step')` 映射为 Pi 的 `steer`——可在运行中途插入指令 |
| 会话持久化 | Pi 以 `--no-session` 运行；持久化来自 DSH 的会话事件（`turn/*`、`step/*`、`tool/call`…） |
| 审批 / 权限 | 适用 Pi 的本地信任模型——Pi 的工具调用不经过 DSH 的审批链 |
| 回退 | 禁用本插件条目，DSH 自己的 `dsh-agent-loop` 立即恢复生效 |

## Subagent 也走 Pi

与主 loop 分离配置：provider 插件是独立的 profile 行，两个引擎可独立开关——主 loop 用 pi + sub 用原生、主 loop 用原生 + sub 用 pi、或两者都用 pi，任意组合。

```yaml
# Subagent 委派走 Pi 引擎（与主 loop 行互不影响）：
- insert:
    - id: subagent-pi
      name: 'dsh-pi-agent/subagent'
      config:
        providerName: pi
        piPath: 'pi'                  # 默认从 PATH 查找
        model: 'provider/model'      # 省略则用 pi 自己配置的默认模型
        timeoutMs: 600000

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: pi                  # 换回 'spawn'/'fork' 即 DSH 原生子代理
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

每次委派在父会话的工作目录里 spawn 一个全新的 `pi -p <任务>`：纯 Pi 系统提示词、自己的工具、自己发现 `AGENTS.md`。父会话的对话、人格、工具面一概不出进程边界——`inheritsParentContext: false`，零提示词碰撞。

## 依赖

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（`npm i -g @earendil-works/pi-coding-agent`）在 `PATH` 上（或传入 `piPath`）
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（`npm i -g @deepseek-ai/dsh`），profile 需暴露 `sessions` 与 `agents` 服务（标准前端装配）
- peer 依赖：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-session`

## 安装

```bash
# 在你的 DSH 检出目录内（或 profile patch 可加载的任意位置）
npm install dsh-pi-agent
```

## 使用

在 profile patch 层（`cordis.patch.yml`）挂载：

```yaml
# 所有新会话使用 Pi loop。
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
      config:
        piPath: 'pi'                      # 或绝对路径
        cwd: '/path/to/your/project'      # Pi 会话的工作目录
        model: 'anthropic/claude-sonnet-4-5'  # provider/model 路由
        debug: false

# 回退到 DSH 自有 loop：禁用此条目并重新启用 agent-loop。
# - id: pi-agent
#   disabled: true
```

### 配置

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Pi 可执行文件；从 `PATH` 解析 |
| `cwd` | `string` | `process.cwd()` | Pi 会话的工作目录 |
| `model` | `string` | — | Pi 模型路由（`provider/model`） |
| `debug` | `boolean` | `false` | 将协议诊断追加到 `/tmp/dsh-pi-agent.log` |

## 调试

设置 `debug: true`（或挂载时传入 `logger`）：每条 RPC 命令、事件、子进程退出和工厂生命周期步骤都会追加到 `/tmp/dsh-pi-agent.log`。Pi 自身的 stderr 也转发到同一日志。

## 许可证

MIT
