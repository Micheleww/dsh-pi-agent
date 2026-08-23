# dsh-pi-agent

在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 中运行 [Pi coding agent](https://github.com/earendil-works/pi) 的 agent loop：一个 DSH `Agent` 插件，驱动无头模式的 `pi --mode rpc` 子进程，DSH 前端（会话日志、hooks、preset、UI）无需任何改动即可使用。

```
DSH 前端（会话、hooks、preset、SQLite 持久化、UI）
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

## 依赖

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 在 `PATH` 上（或传入 `piPath`）
- 带 `sessions` 与 `agents` 服务的 DSH profile（标准前端装配）
- peer 依赖：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`

## 安装

```bash
# 在你的 DSH 检出目录内（或 profile patch 可加载的任意位置）
npm install /path/to/dsh-pi-agent
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
