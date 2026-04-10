# AgentOne — Enterprise AI Agent Design Document

> 使用此文档，AI 编码助手可以从零开始生成完整项目。
> 项目总计 ~3,300 行 TypeScript，15 个源文件。

---

## 1. 项目概览

AgentOne 是一个企业级终端 AI Agent，支持多模型、多工具、子 Agent（Skill）嵌套执行，提供 React+Ink 驱动的 TUI 界面。

### 核心能力

| 能力 | 说明 |
|------|------|
| 多模型切换 | OpenAI / Anthropic / Ollama / OpenRouter / DeepSeek，运行时 `/model` 热切换 |
| 10 个内置 Tool | shell, read_file, write_file, edit_file, glob_files, search, list_dir, web_fetch, todo_write, ask_user |
| Skill 子 Agent | Markdown 定义的专业 Agent，独立工具权限，嵌套深度可视化 |
| 企业级 TUI | 流式输出、工具调用展示、权限确认弹窗、状态栏、子 Agent 缩进层级 |
| 多轮对话 | 持久化 conversation history，跨 turn 上下文连续 |
| 命令系统 | 20+ slash 命令，local 型直接执行不进 agent loop，prompt 型展开后进入 |
| 中断控制 | Ctrl+C 双击退出 agent loop / 退出程序 |
| 权限控制 | 非只读 tool 弹窗确认，`/autorun` 跳过所有确认 |

### 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js (ES2022, ESM) |
| 语言 | TypeScript (strict mode) |
| UI | React 18 + Ink 5 (终端渲染) |
| 状态管理 | 自定义 Store (~30 行, useSyncExternalStore 兼容) |
| Schema | Zod + zod-to-json-schema (工具参数验证 + LLM JSON Schema 生成) |
| Skill 解析 | gray-matter (YAML frontmatter) |
| 文件匹配 | fast-glob |
| 环境配置 | dotenv |

---

## 2. 目录结构

```
agent-one/
├── package.json              # 依赖和脚本
├── tsconfig.json             # TypeScript 配置
├── custom-models.json        # 自定义模型配置（运行时读取）
├── .env.example              # 环境变量模板
├── src/
│   ├── index.tsx             # 入口：CLI 参数解析 + TUI/print 模式分发
│   ├── types.ts              # 全局类型定义
│   ├── store.ts              # 响应式 Store
│   ├── llm.ts                # 多 Provider LLM 客户端（流式+非流式）
│   ├── tools.ts              # Tool 注册表 + 10 个内置工具
│   ├── agent.ts              # Agent 核心引擎（think-act-observe 循环）
│   ├── skills.ts             # Skill 加载器
│   ├── commands.ts           # Slash 命令注册表
│   └── tui/
│       ├── App.tsx           # 根组件：命令分发 + Agent 流式循环 + Ctrl+C
│       ├── hooks.ts          # useStore / useStoreSelector
│       ├── Logo.tsx          # 启动 Logo
│       ├── StatusBar.tsx     # 底部状态栏
│       ├── MessageList.tsx   # 消息列表（支持 depth 缩进）
│       ├── InputBox.tsx      # 用户输入框（历史导航）
│       └── PermissionDialog.tsx  # 权限确认弹窗
└── skills/                   # Skill 定义目录
    ├── code-review.md        # 代码审查 skill
    ├── git-commit.md         # Git 提交 skill
    └── <name>/SKILL.md       # 子目录型 skill（无需 frontmatter）
```

---

## 3. 核心类型 (`types.ts`)

```typescript
// ─── LLM ─────────────────────────────────────────────────────
type LlmRole = "system" | "user" | "assistant" | "tool"

interface LlmMessage {
  role: LlmRole
  content: string
  tool_call_id?: string
  tool_calls?: LlmToolCall[]
}

interface LlmToolCall {
  id: string
  name: string
  argumentsText: string  // JSON 字符串
}

interface LlmResponse {
  content: string
  toolCalls: LlmToolCall[]
  usage?: TokenUsage
}

// 流式事件
interface LlmStreamEvent {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "done" | "error"
  text?: string
  toolCall?: LlmToolCall
  usage?: TokenUsage
  error?: string
}

// ─── Provider ────────────────────────────────────────────────
type ProviderType = "openai" | "anthropic" | "ollama" | "openrouter"

interface ProviderConfig {
  type: ProviderType
  apiKey?: string
  baseUrl: string
  model: string
  maxTokens?: number
  temperature?: number
}

// custom-models.json 条目
interface CustomModelEntry {
  id: string          // 唯一 ID，用于 /model <id>
  value: string       // 实际 model 名
  label: string       // 显示名称
  description?: string
  provider: string    // "ollama" | "openrouter" | "openai" | "anthropic"
  baseURL: string
  apiKey?: string
}

// ─── Tool ────────────────────────────────────────────────────
interface Tool<I = unknown> {
  name: string
  description: string
  inputSchema: ZodType<I>     // Zod schema → 自动生成 JSON Schema 给 LLM
  isReadOnly?: boolean        // true 跳过权限确认
  execute(args: I, ctx: ToolContext): Promise<ToolResult>
}

interface ToolResult {
  ok: boolean
  content: string
}

// ─── Skill ───────────────────────────────────────────────────
interface Skill {
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]     // 限制子 Agent 可用工具
  systemPrompt: string        // Markdown 正文
}

// ─── UI State ────────────────────────────────────────────────
type SessionStatus = "idle" | "thinking" | "tool_running" | "streaming" | "error"

interface UIMessage {
  id: string
  role: LlmRole
  content: string
  toolName?: string
  toolArgs?: string           // 工具参数摘要（用于显示）
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
  depth?: number              // 嵌套深度：0=顶层, 1=子Agent, 2=子子Agent
}

interface AppState {
  status: SessionStatus
  messages: UIMessage[]
  provider: ProviderConfig
  usage: TokenUsage
  inputHistory: string[]
  historyIndex: number
  showPermission: PermissionRequest | null
  errorMessage: string | null
  autoRun: boolean            // /autorun 开关
}

// ─── 命令系统 ────────────────────────────────────────────────
type CommandType = "local" | "prompt" | "local-jsx"

// local: 直接执行，不进 agent loop
interface LocalCommand {
  type: "local"
  name: string
  aliases?: string[]
  description: string
  argumentHint?: string
  execute(args: string, ctx: CommandContext): Promise<LocalCommandResult>
}

// prompt: 展开为 prompt 字符串，送入 agent loop
interface PromptCommand {
  type: "prompt"
  name: string
  description: string
  getPrompt(args: string, ctx: CommandContext): Promise<string>
}

type LocalCommandResult =
  | { type: "text"; value: string }
  | { type: "clear" }
  | { type: "skip" }
```

---

## 4. 响应式 Store (`store.ts`)

~30 行，兼容 React `useSyncExternalStore`：

```typescript
interface Store<T> {
  getState(): T
  setState(updater: (prev: T) => T): void
  subscribe(listener: () => void): () => void
}

function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState(updater) {
      const next = updater(state)
      if (next !== state) { state = next; listeners.forEach(fn => fn()) }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

---

## 5. LLM 客户端 (`llm.ts`)

### 5.1 架构

```
LlmClient
  ├── complete(messages, tools) → LlmResponse       # 非流式
  ├── stream(messages, tools)   → AsyncGenerator     # 流式 SSE
  │
  ├── completeOpenAI()     # OpenAI / DeepSeek / OpenRouter / vLLM
  ├── completeAnthropic()  # Anthropic Messages API
  ├── completeOllama()     # → 复用 completeOpenAI
  └── streamOpenAI()       # SSE 解析 data: [DONE]
```

### 5.2 Provider 适配

| Provider | 端点 | 认证 | 特殊处理 |
|----------|------|------|----------|
| openai | `{baseUrl}/chat/completions` | `Authorization: Bearer` | 标准 OpenAI 格式 |
| anthropic | `{baseUrl}/v1/messages` | `x-api-key` + `anthropic-version` | 消息格式转换 (tool_result → user role) |
| ollama | `{baseUrl}/chat/completions` | 无 | 复用 OpenAI 适配器，baseURL 自动加 `/v1` |
| openrouter | `{baseUrl}/chat/completions` | `Authorization: Bearer` | 复用 OpenAI 适配器，baseURL 自动加 `/v1` |

### 5.3 自定义模型加载

```typescript
// 从 cwd/custom-models.json 加载
async function loadCustomModels(cwd: string): Promise<CustomModelEntry[]>

// 转换为 ProviderConfig
function customModelToProvider(entry: CustomModelEntry): ProviderConfig
```

### 5.4 内置预设 (PROVIDER_PRESETS)

```
gpt-4.1, gpt-4.1-mini, gpt-4.1-nano
claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5
deepseek-chat, deepseek-reasoner
ollama/llama3, ollama/qwen2.5, ollama/deepseek-r1
```

### 5.5 重试策略

- 最大 3 次重试
- 429 → 指数退避 (1s, 2s, 4s)
- 网络错误 → 指数退避重试

---

## 6. 工具系统 (`tools.ts`)

### 6.1 ToolRegistry

```typescript
class ToolRegistry {
  register<I>(tool: Tool<I>): void
  get(name: string): Tool | undefined
  list(): Tool[]
  getOpenAIToolSchemas(): OpenAIToolSchema[]  // Zod → JSON Schema 自动转换
}
```

### 6.2 10 个内置工具

| # | 名称 | 类型 | 说明 | 关键参数 |
|---|------|------|------|----------|
| 1 | `shell` | 写 | 执行 shell 命令 | `command`, `timeoutMs` (max 120s) |
| 2 | `read_file` | 只读 | 读取 UTF-8 文件 | `path`, `offset?`, `limit?` |
| 3 | `write_file` | 写 | 写入文件（自动创建目录） | `path`, `content` |
| 4 | `edit_file` | 写 | 精确字符串替换 | `path`, `old_string`, `new_string` |
| 5 | `glob_files` | 只读 | glob 文件查找 | `pattern` |
| 6 | `search` | 只读 | grep 正则搜索 | `pattern`, `path?`, `glob?` |
| 7 | `list_dir` | 只读 | 列出目录结构 | `path`, `depth` (1-5) |
| 8 | `web_fetch` | 只读 | HTTP 请求 | `url`, `method`, `headers[]`, `body?` |
| 9 | `todo_write` | 只读 | 任务跟踪 | `todos[]` ({content, status}) |
| 10 | `ask_user` | 只读 | 向用户提问 | `question` |

### 6.3 工具参数验证流程

```
LLM 返回 tool_call
  → JSON.parse(argumentsText)
  → Zod schema.safeParse()
  → 失败 → 错误信息返回给 LLM
  → 成功 → 权限检查 → 执行
```

---

## 7. Agent 核心引擎 (`agent.ts`)

### 7.1 Agent 事件类型

```typescript
type AgentEvent =
  | { type: "text_delta"; text: string; depth: number }
  | { type: "tool_call"; toolName: string; args: string; argsSummary: string; depth: number }
  | { type: "tool_result"; toolName: string; result: ToolResult; depth: number }
  | { type: "turn_complete"; turn: number; depth: number }
  | { type: "usage"; usage: TokenUsage }
  | { type: "skill_start"; skillName: string; task: string; depth: number }
  | { type: "skill_end"; skillName: string; ok: boolean; depth: number }
  | { type: "done"; finalText: string }
  | { type: "error"; error: string; depth: number }
```

### 7.2 双模式执行

```
Agent
  ├── run(prompt) → string           # 非流式（CLI -p 模式，子 Agent 回退用）
  └── runStreaming(prompt) → AsyncGenerator<AgentEvent>  # 流式（TUI 用）
```

### 7.3 Agent Loop（think-act-observe）

```
runStreaming(prompt):
  _aborted = false
  conversationHistory.push(userMsg)
  messages = [system, ...conversationHistory]

  for turn in 0..maxTurns:
    if _aborted → yield done, return

    // THINK: 流式调用 LLM
    for event in llm.stream(messages, toolSchemas):
      if _aborted → break
      text_delta → yield
      tool_call_start → 收集

    if _aborted → yield done, return

    // 无工具调用 → 对话结束
    if toolCalls.length === 0 → yield done, return

    // ACT: 执行工具
    for tc in toolCalls:
      if _aborted → yield done, return
      yield tool_call (带 argsSummary)
      if tc.name === "use_skill":
        → executeSkillStreaming() (子 Agent 流式执行，事件冒泡)
      else:
        → executeTool()
      yield tool_result

    // OBSERVE: 工具结果追加到 messages，继续下一轮
```

### 7.4 多轮对话

`conversationHistory: LlmMessage[]` 在 Agent 实例生命周期内持久化。每次 `runStreaming()` 追加 user/assistant/tool 消息。`/clear` 调用 `resetConversation()` 清空。

### 7.5 中断机制

```typescript
abort(): void { this._aborted = true }

// runStreaming 中 3 处检查：
// 1. 每轮开始前
// 2. 每个 stream chunk 读取前
// 3. 每次 tool 执行前
```

### 7.6 Skill 子 Agent 执行

```
use_skill 被调用:
  → yield skill_start { skillName, task, depth: parentDepth+1 }
  → 创建子 Agent (depth+1, maxTurns=15)
  → 继承 onPermissionRequest (autoRun 对子 Agent 也生效)
  → child.runStreaming(task)
    → 每个子事件通过 onSubAgentEvent 回调冒泡到 TUI
  → yield skill_end { skillName, ok, depth }
  → 返回 ToolResult
```

### 7.7 工具参数摘要 (summarizeToolArgs)

为 TUI 显示提取关键参数：

| 工具 | 显示 |
|------|------|
| shell | 命令本身 |
| read_file / write_file / edit_file | 文件路径 |
| glob_files | glob 模式 |
| search | `pattern in path` |
| use_skill | `skillName: task描述` |
| 其他 | JSON 截断到 100 字符 |

---

## 8. Skill 系统 (`skills.ts`)

### 8.1 加载路径

```
skills/**/*.md           # 项目级
.claude/skills/**/*.md   # 用户级
```

排除 `**/output/**`, `**/node_modules/**`, `**/__pycache__/**`。

### 8.2 两种格式

**格式 A — YAML frontmatter：**

```markdown
---
name: oracle-db
description: 管理 Oracle 数据库资产清单
allowed-tools:
  - shell
  - read_file
---

# Oracle 数据库资产管理 Skill
...
```

**格式 B — 无 frontmatter（SKILL.md）：**

```markdown
# Oracle ADG 切换工具

## 概述
Oracle Active Data Guard 切换工具...
```

- `name` → 从目录名推导 (`oracle-adg-switch/SKILL.md` → `oracle-adg-switch`)
- `description` → 从 `## 概述` 段落提取，或 fallback 到首个非标题行

### 8.3 去重

按 name 去重，frontmatter 版本优先。

---

## 9. 命令系统 (`commands.ts`)

### 9.1 三种命令类型

| 类型 | 处理流程 | 进入 Agent Loop? |
|------|----------|:---:|
| `local` | `command.execute(args, ctx)` → 直接显示结果 | 否 |
| `prompt` | `command.getPrompt(args, ctx)` → 送入 `agent.runStreaming()` | 是 |
| `local-jsx` | 同 local（保留扩展用） | 否 |

### 9.2 命令清单

**Local 命令（不进入 Agent Loop）：**

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help` | | 显示所有命令，按 local/prompt 分组 |
| `/clear` | `/cls` | 清空对话历史 + agent.resetConversation() |
| `/model [id]` | | 切换模型（custom-models.json + 内置预设 + 模糊匹配） |
| `/cost` | `/usage` | 显示 token 用量 |
| `/compact [N]` | | 压缩对话到最近 N 条消息 |
| `/status` | | 显示会话状态 + git 信息 |
| `/skills` | | 列出已加载的 skill |
| `/config` | | 显示当前配置 |
| `/autorun` | `/yolo` | 切换自动授权模式（跳过权限确认） |
| `/exit` | `/quit`, `/q` | 退出程序 |

**Prompt 命令（进入 Agent Loop）：**

| 命令 | 说明 |
|------|------|
| `/commit` | 自动 stage + commit |
| `/review [file]` | 代码审查 |
| `/fix <描述>` | 修复 bug |
| `/test [file]` | 运行或编写测试 |
| `/explain <主题>` | 解释代码或概念 |
| `/refactor <目标>` | 重构代码 |
| `/search <查询>` | 搜索代码库（别名 /find, /grep） |
| `/build` | 构建项目并修复错误 |
| `/pr [base]` | 创建 Pull Request |
| `/docs [主题]` | 生成或更新文档 |
| `/sh <命令>` | 通过 agent 执行 shell（别名 /shell, /bash） |
| `/plan <任务>` | 制定实施计划（不执行） |
| `/summary [对象]` | 总结变更或文件 |

### 9.3 命令查找（支持别名）

```typescript
function findCommand(name: string, commands: Command[]): Command | undefined {
  return commands.find(c => c.name === name || c.aliases?.includes(name))
}
```

### 9.4 命令分发流程 (App.tsx)

```
用户输入
  → parseSlashCommand(input)
  ├── 匹配到 local/local-jsx
  │     → command.execute(args, ctx)
  │     → 结果: text → 显示 | clear → 清屏 | skip → 忽略
  ├── 匹配到 prompt
  │     → command.getPrompt(args, ctx)
  │     → runAgent(prompt, 原始输入作为显示)
  ├── 未知斜杠命令 → 显示错误
  └── 非斜杠命令（自然语言）→ runAgent(input)
```

---

## 10. TUI 架构

### 10.1 组件树

```
<App>
  ├── <Logo>                    # 启动时显示（无消息时）
  ├── <MessageList>             # 消息列表，depth>0 显示 │ 竖线缩进
  │     ├── UserMessage         # ❯ 蓝色
  │     ├── AssistantMessage    # ◆ 绿色（depth>0 用 ◇ 青色）
  │     ├── ToolCallMessage     # ⚙ 品红色 (工具名 + 参数摘要)
  │     ├── ToolResultMessage   # ✓/✗ 灰/红色
  │     ├── SystemMessage       # 暗灰斜体
  │     └── Spinner             # 等待时显示
  ├── <PermissionDialog>        # 条件渲染（showPermission 非 null）
  ├── <InputBox>                # 用户输入（disabled 时显示 Processing...）
  └── <StatusBar>               # 底部：状态 | 模型 | AUTORUN | tokens
```

### 10.2 消息深度缩进

```
depth=0:  ❯ 检查orclm数据库
depth=0:  ⚙ use_skill (oracle-health-check-repair: 检查orclm)
depth=1:  │ ▶ [oracle-health-check-repair] 检查orclm
depth=1:  │ ⚙ shell (bash run.sh orclm)
depth=1:  │ ✓ 检查结果...
depth=1:  │ ◇ 子Agent分析结论...
depth=1:  │ ✓ [oracle-health-check-repair] completed
depth=0:  ◆ 主Agent最终回复
```

深度颜色循环：magenta → cyan → yellow → blue → green

### 10.3 状态栏

```
┌─────────────────────────────────────────────────────────────┐
│ ● IDLE  | qwen3:8b (ollama)        AUTORUN | tokens: 1,234 │
└─────────────────────────────────────────────────────────────┘
```

状态图标/颜色：idle(绿●), thinking(黄◐), streaming(青▸), tool_running(品红⚙), error(红✗)

### 10.4 Ctrl+C 双击逻辑

```
useInput 捕获 Ctrl+C (input === "c" && key.ctrl):

if 正在处理 (status !== idle/error):
  第1次 → agent.abort() + 显示 "Interrupting..."
  第2次 (1.5s内) → 强制中断，状态回 idle
else (空闲):
  第1次 → 显示 "Press Ctrl+C again to exit."
  第2次 (1.5s内) → exit()
```

注意：Ink `exitOnCtrlC` 必须设为 `false`，因为 raw mode 下 Ctrl+C 不触发 SIGINT。

### 10.5 Sub-Agent 事件冒泡

```
Agent (depth=0)
  │ onSubAgentEvent = (event) => 写入 TUI messages
  │
  └── executeSkillStreaming()
        │ yield skill_start
        │ child.runStreaming()
        │   ├── text_delta (depth=1) → emitSubEvent → TUI
        │   ├── tool_call (depth=1)  → emitSubEvent → TUI
        │   ├── tool_result (depth=1) → emitSubEvent → TUI
        │   └── done
        │ yield skill_end
```

App.tsx 的 `handleSubAgentEvent` 处理所有子事件类型，写入 messages 并带上 depth。

---

## 11. 入口点 (`index.tsx`)

### 11.1 启动流程

```
main():
  parseArgs() → { printMode, prompt, model }
  loadCustomModels(cwd) + loadSkills(cwd)  // 并行加载

  // Provider 优先级: --model > 环境变量 > custom-models.json[0]
  resolveProvider()

  // API key 校验（ollama 除外）

  if printMode:
    agent.run(prompt) → stdout
  else:
    render(<App>, { exitOnCtrlC: false })
```

### 11.2 CLI 用法

```bash
agent-one                              # 交互式 TUI
agent-one -p "list files"             # 非交互（stdout 输出）
agent-one --model ollama-qwen3-8b     # 指定模型
agent-one --model claude-sonnet-4-6   # 内置预设
agent-one -h                          # 帮助
```

### 11.3 环境变量

```bash
OPENAI_API_KEY        # OpenAI / DeepSeek / OpenRouter
ANTHROPIC_API_KEY     # Anthropic
OPENAI_BASE_URL       # 自定义 base URL
OPENAI_MODEL          # 模型名
PROVIDER_TYPE         # "openai" | "anthropic" | "ollama"
```

---

## 12. 配置文件

### 12.1 custom-models.json

```json
{
  "models": [
    {
      "id": "ollama-qwen3-8b",
      "value": "qwen3:8b",
      "label": "Ollama Qwen3 8B",
      "description": "Qwen3 8B via Ollama (local)",
      "provider": "ollama",
      "baseURL": "http://localhost:11434",
      "apiKey": "ollama"
    },
    {
      "id": "openrouter-qwen36-plus",
      "value": "qwen/qwen3.6-plus:free",
      "label": "OpenRouter Qwen 3.6 Plus (Free)",
      "provider": "openrouter",
      "baseURL": "https://openrouter.ai/api",
      "apiKey": "sk-or-v1-xxx"
    }
  ]
}
```

- `id` — `/model <id>` 中使用的标识
- `value` — 发给 API 的实际 model 名
- `provider` — 决定使用哪个适配器
- `baseURL` — API 端点（ollama/openrouter 自动追加 `/v1`）

### 12.2 Skill 文件格式

```markdown
---
name: code-review
description: 代码审查
when-to-use: 当用户请求代码审查时
allowed-tools:
  - read_file
  - glob_files
  - search
---

# 代码审查 Skill

你是一位高级代码审查员...
```

---

## 13. 数据流

### 13.1 完整查询流

```
用户输入 "检查orclm数据库"
    │
    ▼
App.handleSubmit()
    │
    ├── parseSlashCommand() → null (非命令)
    │
    └── runAgent("检查orclm数据库")
          │
          ├── 添加 user UIMessage
          ├── store.status = "thinking"
          │
          └── for await (agent.runStreaming(prompt)):
                │
                ├── text_delta → 更新 assistant UIMessage (streaming)
                │
                ├── tool_call (use_skill) → 添加 tool UIMessage
                │     │
                │     └── executeSkillStreaming()
                │           ├── skill_start → handleSubAgentEvent → 添加 system msg (depth=1)
                │           ├── child.runStreaming():
                │           │     ├── tool_call (shell) → handleSubAgentEvent (depth=1)
                │           │     ├── tool_result → handleSubAgentEvent (depth=1)
                │           │     ├── text_delta → handleSubAgentEvent (depth=1)
                │           │     └── done
                │           └── skill_end → handleSubAgentEvent
                │
                ├── tool_result (use_skill) → 跳过显示（子事件已展示）
                │
                ├── text_delta → 更新 assistant UIMessage
                │
                └── done → finalize, status = "idle"
```

### 13.2 权限检查流

```
tool.isReadOnly?
    ├── true → 直接执行
    └── false
          ├── state.autoRun? → true → 直接执行
          └── false → 显示 PermissionDialog
                ├── [Y] → resolve(true) → 执行
                └── [N] → resolve(false) → 返回 "denied" 给 LLM
```

---

## 14. 依赖清单

```json
{
  "dependencies": {
    "dotenv": "^16.4.5",
    "fast-glob": "^3.3.3",
    "gray-matter": "^4.0.3",
    "ink": "^5.1.0",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.1",
    "zod": "^3.24.1",
    "zod-to-json-schema": "^3.23.5"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.18",
    "typescript": "^5.7.2"
  }
}
```

### TypeScript 配置要点

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

---

## 15. 构建和运行

```bash
# 安装依赖
npm install

# 编译
npm run build    # tsc → dist/

# 运行
npm start        # node dist/index.js

# 开发模式
npm run dev      # tsc --watch
```

---

## 16. 关键设计决策

| 决策 | 原因 |
|------|------|
| 使用 Ink 而非 blessed/raw ANSI | React 组件模型，声明式 UI，生态丰富 |
| Zod 而非手写验证 | 运行时验证 + 自动生成 JSON Schema 给 LLM |
| 流式执行子 Agent | 用户可以实时看到 skill 内部操作过程 |
| depth 字段而非嵌套组件 | 所有消息扁平存储，渲染时按 depth 缩进，简化状态管理 |
| 双模式 Agent (run/runStreaming) | TUI 需要流式事件，CLI -p 模式需要同步返回 |
| custom-models.json 外部配置 | 不编码 API key，支持多环境切换 |
| local/prompt 命令分类 | 本地命令即时响应不消耗 token，prompt 命令利用 LLM 能力 |
| SIGINT → useInput | Ink raw mode 下 Ctrl+C 不产生 SIGINT，必须用 useInput 捕获 |
