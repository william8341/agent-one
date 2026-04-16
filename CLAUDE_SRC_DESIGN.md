# Claude Code — Complete Architecture Design Document

> Generated from source analysis of `/Users/shangweilie/Downloads/claude-src` + cross-reference analysis
> Source: ~16,037 symbols, 48,813 relationships, 300 execution flows

---

## 1. System Overview

Claude Code is Anthropic's official AI-assisted development CLI tool, supporting **four runtime modes**: terminal CLI, VS Code/JetBrains IDE extensions, Web app (claude.ai/code), and Agent SDK. Its core capability is interacting with Claude LLM via natural language to execute code editing, file operations, shell commands, and other software engineering tasks.

### 1.1 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | **Bun** (with `bun:bundle` feature flags for compile-time dead code elimination) |
| Language | **TypeScript** (strict mode, ESNext) |
| UI | **React + Ink** (custom fork — terminal rendering engine with Yoga Layout, double-buffered frames) |
| CLI | **Commander.js** (`@commander-js/extra-typings`) |
| State | **Custom lightweight Store** (~35 lines, compatible with React `useSyncExternalStore`) |
| API | **@anthropic-ai/sdk** (supports 4 backends: Direct, AWS Bedrock, Azure Foundry, GCP Vertex) |
| Protocol | **MCP** (Model Context Protocol), **LSP** (Language Server Protocol) |
| Build | Bun bundler with `feature()` macro for compile-time DCE |

### 1.2 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Entry Layer (Entrypoints)                    │
│  cli.tsx → main.tsx → setup.ts → init.ts → replLauncher.tsx     │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│                      UI Layer (React/Ink)                        │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ App.tsx  │  │ REPL Screen│  │ Dialogs  │  │  Components  │  │
│  └────┬─────┘  └─────┬──────┘  └────┬─────┘  └──────┬───────┘  │
│       └───────────────┴──────────────┴───────────────┘          │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────┐     │
│  │          AppState Store (state/store.ts)                 │     │
│  │  Session settings │ UI chrome │ Tasks │ MCP │ Bridge    │     │
│  └─────────────────────────────────────────────────────────┘     │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│                    Core Engine Layer                             │
│  ┌──────────────┐    ┌────────────┐    ┌──────────────────┐     │
│  │ QueryEngine  │───▶│  query()   │───▶│ API Client       │     │
│  │ (orchestrate) │    │ (Agent loop)│   │ (stream/non-stream)│    │
│  └──────────────┘    └─────┬──────┘    └──────────────────┘     │
│                            │                                     │
│                    ┌───────▼───────┐                              │
│                    │  Tool System  │                              │
│                    │ (register/exec)│                             │
│                    └───────────────┘                              │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│                      Service Layer                               │
│  ┌─────┐ ┌──────┐ ┌───────┐ ┌──────┐ ┌────────┐ ┌──────────┐  │
│  │ MCP │ │ LSP  │ │ OAuth │ │Bridge│ │Compact │ │Analytics │  │
│  └─────┘ └──────┘ └───────┘ └──────┘ └────────┘ └──────────┘  │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│                    Persistence Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ History  │  │ Memory   │  │  Config  │  │ Session Memory │  │
│  │ (JSONL)  │  │ (memdir) │  │ (JSON)   │  │ (Markdown)     │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Module Dependency Graph

```
entrypoints/cli.tsx
 └── main.tsx
      ├── commands.ts ─── commands/*
      ├── tools.ts ────── tools/*
      ├── setup.ts
      ├── replLauncher.tsx
      │     ├── components/App.tsx
      │     │     └── state/AppState.tsx → state/store.ts
      │     └── screens/REPL
      │           └── QueryEngine.ts
      │                 ├── query.ts
      │                 │     ├── services/api/claude.ts (API calls)
      │                 │     ├── services/compact/* (context compaction)
      │                 │     └── Tool.ts (tool execution)
      │                 ├── context.ts (context assembly)
      │                 ├── memdir/* (memory system)
      │                 └── history.ts (history persistence)
      │
      ├── services/mcp/* (MCP servers)
      ├── services/lsp/* (LSP integration)
      ├── services/oauth/* (authentication)
      ├── bridge/* (remote sessions)
      ├── skills/* (skill system)
      └── plugins/* (plugin system)
```

---

## 2. Entry Point & Startup

### 2.1 cli.tsx — Fast Path Dispatch

The outermost entry point implements **zero-module-load fast paths**:

```
cli.tsx
    ├── --version / -v  → print version, exit immediately (no module imports)
    ├── --dump-system-prompt → output system prompt, exit
    └── normal startup → main.tsx
```

This ensures `claude --version` returns in <10ms without loading any dependencies.

### 2.2 main.tsx — Startup Sequence

```
process start
    ↓
profileCheckpoint('main_tsx_entry')
    ↓
startMdmRawRead()         — parallel MDM settings subprocess
startKeychainPrefetch()   — parallel macOS keychain reads
preconnectAnthropicApi()  — parallel API preconnection
    ↓
Import all modules (~135ms, parallel with above subprocesses)
    ↓
profileCheckpoint('main_tsx_imports_loaded')
    ↓
main()
    ├── SECURITY: NoDefaultCurrentDirectoryInExePath (Windows PATH hijacking prevention)
    ├── Initialize warning handler
    ├── SIGINT handler (skip for -p/--print mode)
    ├── Parse feature flags (DIRECT_CONNECT, KAIROS, SSH_REMOTE, etc.)
    ├── Handle deep link URIs (--handle-uri, macOS URL handler)
    ├── Parse special subcommands (assistant, ssh, cc:// URLs)
    ├── Detect mode (-p/--print, --init-only, --sdk-url, non-TTY)
    ├── Determine client type (cli, sdk-cli, sdk-typescript, remote, claude-vscode, etc.)
    ├── eagerLoadSettings() — parse --settings flag early
    └── run()
```

**Key optimization**: MDM/Keychain/API subprocesses fire **before** module imports, completing during the ~135ms import window — saving ~65ms of sequential startup time.

### 2.3 `run()` — CLI Command Setup

Uses **Commander.js** with `preAction` hook pattern:

```typescript
program
  .name('claude')
  .description('Claude Code - starts interactive session by default, use -p/--print for non-interactive')
  .argument('[prompt]', 'Your prompt')
  .option('-d, --debug [filter]', 'Enable debug mode with optional category filtering')
  .option('-p, --print', 'Non-interactive output')
  .option('--dangerously-skip-permissions', 'Skip all permission checks')
  .option('--permission-mode <mode>', 'Set permission mode')
  .option('--worktree', 'Create a git worktree for this session')
  .option('--model <model>', 'Model to use')
  .option('--settings <path|json>', 'Load settings from file or JSON string')
  .option('--plugin-dir <dir>', 'Additional plugin directory', collect, [])
  // ... 50+ options
  .hook('preAction', async thisCommand => {
    // Await parallel subprocesses started at module evaluation
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])
    await init()                                    // Configuration, auth, telemetry
    process.title = 'claude'                        // Set terminal title
    initSinks()                                     // Attach logging sinks
    runMigrations()                                 // Data migrations
    void loadRemoteManagedSettings()                // Enterprise settings (non-blocking)
    void loadPolicyLimits()                         // Enterprise policy limits
    void uploadUserSettingsInBackground()           // Settings sync (UPLOAD_USER_SETTINGS)
  })
```

### 2.4 init() — Initialization (`init.ts`)

```
init()
    ├── Configuration loading (settings.json, env vars, CA certs)
    ├── OAuth/authentication initialization
    ├── Telemetry initialization (OpenTelemetry — lazy loaded, ~400KB + gRPC ~700KB)
    ├── Policy limits loading (enterprise)
    └── Git root detection & CWD setup
```

### 2.5 Feature Flags (`bun:bundle`)

Compile-time dead code elimination via `feature()` macro:

| Feature | Purpose |
|---------|---------|
| `COORDINATOR_MODE` | Multi-agent coordinator/worker pattern |
| `KAIROS` | Assistant mode (proactive AI) |
| `KAIROS_PUSH_NOTIFICATION` | Push notifications for assistant |
| `KAIROS_BRIEF` | Brief generation |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub webhook integration |
| `SSH_REMOTE` | SSH remote sessions |
| `DIRECT_CONNECT` | Direct connection (cc:// URLs) |
| `DAEMON` | Daemon/bridge mode |
| `BRIDGE_MODE` | Remote control bridge |
| `HISTORY_SNIP` | Context compaction (snip-based) |
| `WORKFLOW_SCRIPTS` | Workflow automation |
| `AGENT_TRIGGERS` | Cron/scheduled triggers |
| `AGENT_TRIGGERS_REMOTE` | Remote trigger support |
| `UDS_INBOX` | Unix domain socket messaging |
| `CONTEXT_COLLAPSE` | Context window management |
| `FORK_SUBAGENT` | Subagent forking |
| `WEB_BROWSER_TOOL` | Browser integration |
| `MONITOR_TOOL` | Monitoring capabilities |
| `PROACTIVE` | Proactive AI features |
| `TRANSCRIPT_CLASSIFIER` | Auto-mode transcript classification |
| `OVERFLOW_TEST_TOOL` | Test tool for overflow |
| `TERMINAL_PANEL` | Terminal panel integration |
| `CCR_REMOTE_SETUP` | CCR remote setup |
| `EXPERIMENTAL_SKILL_SEARCH` | Skill search indexing |
| `UPLOAD_USER_SETTINGS` | Settings sync to cloud |
| `MCP_SKILLS` | MCP-provided skills |
| `VOICE_MODE` | Voice interaction |
| `LODESTONE` | Deep link handling |
| `BUDDY` | Buddy feature |
| `TORCH` | Torch feature |
| `ULTRAPLAN` | Ultra planning |
| `OVERFLOW_TEST_TOOL` | Overflow testing |

### 2.6 Migrations

Sync migrations run at startup (version-gated, `CURRENT_MIGRATION_VERSION = 11`):

```typescript
migrateAutoUpdatesToSettings()
migrateBypassPermissionsAcceptedToSettings()
migrateEnableAllProjectMcpServersToSettings()
resetProToOpusDefault()
migrateSonnet1mToSonnet45()
migrateLegacyOpusToCurrent()
migrateSonnet45ToSonnet46()
migrateOpusToOpus1m()
migrateReplBridgeEnabledToRemoteControlAtStartup()
resetAutoModeOptInForDefaultOffer()  // TRANSCRIPT_CLASSIFIER feature
migrateFennecToOpus()                 // ant-only
// Async (fire-and-forget):
migrateChangelogFromConfig()
```

---

## 3. Session Setup (`setup.ts`)

The `setup()` function initializes the session environment:

```
setup(cwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, ...)
    ↓
Node.js version check (>= 18 required)
    ↓
Switch session (if customSessionId)
    ↓
Start UDS messaging server (Mac/Linux, non-bare mode, UDS_INBOX feature)
    ↓
Capture teammate mode snapshot (agent swarms)
    ↓
Terminal backup restoration (iTerm2 / Terminal.app — interactive only)
    ↓
setCwd(cwd) — CRITICAL: must be before any hooks
    ↓
Capture hooks configuration snapshot (from correct directory)
    ↓
Initialize FileChanged watcher
    ↓
Worktree creation (if --worktree enabled)
    ├── findCanonicalGitRoot() — resolve to main repo if in worktree
    ├── createWorktreeForSession() — git worktree or hook-delegated
    ├── createTmuxSessionForWorktree() (if --tmux)
    ├── setCwd(worktreePath)
    ├── setProjectRoot(worktreePath)
    └── updateHooksConfigSnapshot() — re-read from worktree
    ↓
Background jobs (non-blocking):
    ├── initSessionMemory() — register hook, lazy gate check
    ├── initContextCollapse() (CONTEXT_COLLAPSE feature)
    └── lockCurrentVersion() — prevent deletion by other processes
    ↓
Prefetch (fire-and-forget):
    ├── getCommands(projectRoot) — load command registry
    ├── loadPluginHooks() + setupPluginHookHotReload()
    ├── registerAttributionHooks() (deferred via setImmediate)
    ├── registerSessionFileAccessHooks()
    └── startTeamMemoryWatcher() (TEAMMEM feature)
    ↓
initSinks() — attach error log + analytics sinks, drain queued events
    ↓
logEvent('tengu_started') — startup beacon (earliest reliable signal)
    ↓
prefetchApiKeyFromApiKeyHelperIfSafe()
    ↓
checkForReleaseNotes() + getRecentActivity() (interactive only)
    ↓
Permission safety gates:
    ├── No root/sudo with --dangerously-skip-permissions
    └── For ants: Docker + internet access verification
    ↓
Log previous session exit metrics (tengu_exit event)
```

---

## 4. Core Query Loop — The Heart of the System

### 4.1 Architecture Separation: QueryEngine + query()

Following Claude Code's architecture, the query system is split into two modules:

- **`QueryEngine`** (orchestrator): Session lifecycle, context compaction, error recovery, system prompt assembly
- **`query()`** (core API loop): Standalone async generator for API interaction and tool execution

This separation allows:
- Independent testing of the API interaction loop
- Reuse of `query()` by sub-agents and forked processes
- Clean error boundary between orchestration and API calls

```
QueryEngine (orchestrator)
    ├── submitMessage() — entry point
    ├── Context compaction (budget → snip → micro → auto)
    ├── Error recovery (413 retry, max_tokens retry, fallback model)
    ├── Session persistence (JSONL transcript)
    └── Delegates to: query() — core API interaction

query() (core API loop)
    ├── Anthropic SDK client (messages.create)
    ├── Response parsing (text blocks + tool_use blocks)
    ├── StreamingToolExecutor — parallel tool execution
    └── Recursive call with tool results appended
```

### 4.2 QueryEngine Architecture

The `QueryEngine` class owns the complete AI query lifecycle:

```
QueryEngine.submitMessage(prompt)
    ↓
├── Record user message + transcript
├── yield stream_request_start
├── while(true) loop:
│   ├── Abort check, turn count, budget check
│   ├── Context preprocessing:
│   │   ├── applyToolResultBudget — truncate oversized results
│   │   ├── snipCompactIfNeeded — snip oldest history segments
│   │   ├── microcompact — fine-grained single tool compression
│   │   └── autoCompact — full session summary when > threshold
│   ├── try:
│   │   └── yield* query(params) — delegate to core API loop
│   └── catch:
│       ├── prompt_too_long (413) → compress + retry
│       ├── max_output_tokens → compress + retry (3x)
│       └── fallback model → switch model + retry
└── yield TerminalReason (success / max_turns / max_budget / model_error / aborted)
```

### 4.3 Query Loop (`query()`) — Core API Interaction

The standalone `query()` async generator implements the Agent "think-act-observe" cycle:

```
query(params) [async generator]
    │
    │  ┌─────────────────────────────────────────────────────────┐
    │  │ Each iteration:                                          │
    │  │                                                          │
    │  │ 1. API Call                                              │
    │  │    ├── Anthropic.messages.create() — non-streaming      │
    │  │    ├── 429 retry with exponential backoff (3x)          │
    │  │    └── Parse response blocks (text + tool_use)           │
    │  │                                                          │
    │  │ 2. Stream Events                                         │
    │  │    ├── text_delta → yield + onText callback              │
    │  │    ├── tool_use_start → yield                            │
    │  │    └── assistant_message → yield                         │
    │  │                                                          │
    │  │ 3. Tool Execution                                        │
    │  │    ├── StreamingToolExecutor — parallel execution        │
    │  │    ├── Permission check (deny/ask/allow)                 │
    │  │    └── Collect ToolResult → build next messages          │
    │  │                                                          │
    │  │ 4. Recursion                                             │
    │  │    ├── Has tool calls → query(nextMessages, depth + 1)   │
    │  │    ├── Has text → done                                   │
    │  │    └── Empty → yield no-response message                 │
    │  └─────────────────────────────────────────────────────────┘
    │
    ▼
yield StreamEvent (text_delta, tool_use_start, tool_use_complete, assistant_message)
```

### 4.4 StreamingToolExecutor

Parallel tool execution during the API response cycle:

```
StreamingToolExecutor
    ├── addTool(toolBlock) — queue tool for execution
    ├── executeQueued() — background async execution
    ├── getCompletedResults() — consume results (clears buffer)
    └── discard() — cancel pending execution
```

### 4.5 System Prompt Architecture

The system prompt is assembled from multiple sources in `generateSystemPrompt()`:

```
generateSystemPrompt()
    ├── ROLE_DEFINITION — identity and capabilities
    ├── SAFETY_RULES — destructive command protection
    ├── TOOL_GUIDELINES — tool selection strategy and usage patterns
    ├── ERROR_DIAGNOSIS_GUIDELINES — step-by-step error handling protocol
    ├── Current Environment — working directory, OS, project info, git status
    └── BEHAVIOR_GUIDELINES — execution-first behavior, troubleshooting protocol
```

#### Error Diagnosis Protocol

When a tool command fails, the model is instructed to:

1. **Read the error output carefully** — understand WHAT failed and WHY
2. **Gather more information** before trying another fix:
   - Read relevant error logs (e.g., /var/log/, .err files)
   - Check process status (ps aux, systemctl status, brew services list)
   - Check file/directory existence and permissions
   - Check versions and compatibility
3. **Identify the root cause** — don't just retry the same command
4. **Try a different approach** based on diagnosis
5. **If still stuck**, explain what was tried and what the errors mean

#### Tool Result Format

Bash tool results are formatted for model readability:

```
# Success with output:
<command output>

# Success with no output:
(Command succeeded with no output)

# Failure:
Exit code: 1
<error output>
```

The exit code is explicitly included for failures so the model can distinguish between different failure modes (exit code 1 vs 127 vs 137).

### 4.5 Streaming Tool Execution
```

### 4.4 Streaming Tool Execution

**Key optimization**: `StreamingToolExecutor` begins executing tool calls **during** the model's streaming output, not after the full response. This significantly reduces perceived latency — tools start running as soon as the model decides to call them, even while still generating text.

### 4.5 Error Recovery

| Error | Recovery Strategy |
|-------|------------------|
| `prompt_too_long` (413) | Reactive compact → retry |
| `max_output_tokens` | Expand to 64K → retry (max 3x) |
| `FallbackTriggeredError` | Switch to fallback model |
| API rate limit | Exponential backoff retry |

### 4.6 `ask()` Convenience Wrapper

```typescript
export async function* ask({
  commands, prompt, cwd, tools, mcpClients,
  canUseTool, mutableMessages, getReadFileCache, setReadFileCache,
  customSystemPrompt, appendSystemPrompt, userSpecifiedModel,
  fallbackModel, jsonSchema, getAppState, setAppState,
  abortController, replayUserMessages, includePartialMessages,
  handleElicitation, agents, setSDKStatus, orphanedPermission,
}): AsyncGenerator<SDKMessage> {
  const engine = new QueryEngine({ ... })
  try {
    yield* engine.submitMessage(prompt, { uuid, isMeta })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
```

---

## 5. Tool System (`Tool.ts` + `tools/`)

### 5.1 Tool Interface

The `Tool<T>` type is the core abstraction — every tool implements this interface:

```typescript
type Tool<Input, Output, Progress> = {
  name: string
  aliases?: string[]
  searchHint?: string              // 3-10 word keyword for ToolSearch
  shouldDefer?: boolean            // deferred loading via ToolSearch
  alwaysLoad?: boolean             // never defer this tool

  // Core execution
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>

  // Dynamic description (permission-aware, injected into system prompt)
  description(input, options): Promise<string>

  // Prompt injection (instructions for the model)
  prompt(options): Promise<string>

  // Schema
  inputSchema: ZodType<Input>
  inputJSONSchema?: ToolInputJSONSchema  // for MCP tools
  outputSchema?: ZodType<Output>

  // Safety & behavior
  isEnabled(): boolean
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'
  checkPermissions(input, context): Promise<PermissionResult>
  validateInput?(input, context): Promise<ValidationResult>

  // UI rendering (React/Ink)
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progress, options): React.ReactNode
  renderToolUseProgressMessage?(progress, options): React.ReactNode
  renderToolUseErrorMessage?(result, options): React.ReactNode
  renderToolUseTag?(input): React.ReactNode
  renderGroupedToolUse?(toolUses, options): React.ReactNode | null
  renderToolUseRejectedMessage?(input, options): React.ReactNode

  // Metadata
  getActivityDescription?(input): string | null
  getToolUseSummary?(input): string | null
  toAutoClassifierInput(input): unknown
  isSearchOrReadCommand?(input): { isSearch, isRead, isList }
  isOpenWorld?(input): boolean
  requiresUserInteraction?(): boolean

  // MCP support
  isMcp?: boolean
  isLsp?: boolean
  mcpInfo?: { serverName, toolName }

  // Result handling
  maxResultSizeChars: number
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam
  extractSearchText?(out): string
  isResultTruncated?(output): boolean
  backfillObservableInput?(input): void
  preparePermissionMatcher?(input): Promise<(pattern) => boolean>
  getPath?(input): string
}
```

### 5.2 `buildTool()` Factory

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,       // fail-closed
  isReadOnly: () => false,              // assume writes
  isDestructive: () => false,
  checkPermissions: (input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',      // skip classifier unless overridden
  userFacingName: () => '',
}

export function buildTool<D>(def: D): BuiltTool<D> {
  return { ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def } as BuiltTool<D>
}
```

### 5.3 Tool Registry (`tools.ts`)

```
getAllBaseTools()
    ↓
[AgentTool, TaskOutputTool, BashTool, GlobTool, GrepTool,
 ExitPlanModeV2Tool, FileReadTool, FileEditTool, FileWriteTool,
 NotebookEditTool, WebFetchTool, TodoWriteTool, WebSearchTool,
 TaskStopTool, AskUserQuestionTool, SkillTool, EnterPlanModeTool,
 ConfigTool, TungstenTool, WebBrowserTool, TaskCreateTool, ...]
    ↓
filterToolsByDenyRules(tools, permissionContext)
    ↓
Filter by REPL mode (hide primitives when REPL enabled)
    ↓
Filter by isEnabled()
    ↓
getTools(permissionContext) → Tools
    ↓
assembleToolPool(permissionContext, mcpTools) → merged tool pool
    (built-in tools sorted by name + MCP tools sorted by name, dedup by name)
```

### 5.4 Built-in Tools (Categorized)

| Category | Tool | Purpose |
|----------|------|---------|
| **File Operations** | FileReadTool | Read file contents |
| | FileEditTool | Precise string replacement (old_string → new_string) |
| | FileWriteTool | Create/overwrite files |
| | GlobTool | File pattern matching (glob) |
| | GrepTool | Regex content search (ripgrep-based) |
| | NotebookEditTool | Jupyter Notebook editing |
| **Execution** | BashTool | Shell command execution (timeout, background, sandbox) |
| | AgentTool | Sub-agent spawning (foreground/background/worktree isolation) |
| | SkillTool | Skill invocation (slash commands for model) |
| **Task Management** | TaskCreate/Get/List/Update/Stop/OutputTool | Background task lifecycle |
| | TodoWriteTool | Todo list management |
| **Network** | WebFetchTool | URL content fetching |
| | WebSearchTool | Web search |
| **Interaction** | AskUserQuestionTool | Interactive user questions |
| | SendMessageTool | Inter-agent messaging |
| **Planning** | EnterPlanModeTool / ExitPlanModeV2Tool | Plan mode toggle |
| **MCP** | ListMcpResourcesTool / ReadMcpResourceTool | MCP resource access |
| **Other** | ToolSearchTool | Deferred tool schema retrieval |
| | TeamCreate/DeleteTool | Multi-agent team management |
| | EnterWorktreeTool / ExitWorktreeTool | Git worktree isolation |
| | LSPTool | Language Server Protocol integration |
| | WebBrowserTool | Browser automation |
| | WorkflowTool | Workflow script execution |
| | ConfigTool | Configuration management (ant-only) |
| | TungstenTool | Internal tool (ant-only) |
| | BriefTool | Brief generation |
| | REPLTool | REPL-in-REPL (ant-only) |

**Feature-flagged tools**: REPLTool (ant-only), SleepTool (PROACTIVE/KAIROS), CronTools (AGENT_TRIGGERS), RemoteTriggerTool, MonitorTool, SendUserFileTool, PushNotificationTool, SubscribePRTool, PowerShellTool, SnipTool, TerminalCaptureTool, CtxInspectTool, OverflowTestTool, ListPeersTool, WebBrowserTool.

### 5.5 Tool Presets

```typescript
export const TOOL_PRESETS = ['default'] as const
// --simple mode: only Bash, Read, Edit (+ REPL if REPL mode enabled)
```

---

## 6. Permission System

### 6.1 ToolPermissionContext

```typescript
type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  shouldAvoidPermissionPrompts?: boolean
  awaitAutomatedChecksBeforeDialog?: boolean
  prePlanMode?: PermissionMode
}
```

### 6.2 Permission Flow

```
Model requests tool use
    ↓
validateInput() — tool-specific validation
    ↓
checkPermissions() — tool-specific permission check
    (e.g., FileEditTool → checkWritePermissionForTool() protects .gitconfig, .bashrc, .claude/)
    ↓
hasPermissionsToUseTool() — general permission gate
    ├── 1. PermissionMode check
    │   ├── bypassPermissions → allow all
    │   ├── plan → deny all (read-only only)
    │   └── default / acceptEdits / auto → continue
    │
    ├── 2. Rule matching (by source priority)
    │   ├── Policy (enterprise) — highest priority
    │   ├── CLI flags (--allowedTools)
    │   ├── User settings (~/.claude/settings.json)
    │   ├── Project settings (.claude/settings.json)
    │   └── Local settings (.claude/settings.local.json)
    │
    ├── 3. Tool's own checkPermissions()
    │
    ├── 4. Auto-mode classifier (optional, TRANSCRIPT_CLASSIFIER feature)
    │
    └── 5. PreToolUse hook
    ↓
PermissionResult = Allow | Deny | Ask
    ├── Allow → execute directly
    ├── Deny → return rejection to model
    └── Ask → interactive permission dialog
            User options: Allow / Deny / Allow always / Deny always
```

### 6.3 PermissionMode Enum

| Mode | Behavior |
|------|----------|
| `default` | Standard permission checking |
| `acceptEdits` | Auto-accept file edits |
| `bypassPermissions` | Skip all checks (sandbox/Docker only, no internet) |
| `dontAsk` | Never ask, auto-decide |
| `plan` | Plan mode (read-only tools only) |
| `auto` | Auto-mode with classifier |
| `bubble` | Bubblewrap sandbox mode |

### 6.4 Security Design

- **Fail-closed defaults**: `isReadOnly=false`, `isConcurrencySafe=false`
- **Filesystem protection**: Sensitive paths (.gitconfig, .bashrc, .claude/) auto-intercepted
- **macOS/Windows path case normalization** prevents bypass
- **Memory system path injection protection**
- **Task ID cryptography**: Random + case-insensitive alphabet prevents symlink attacks
- **Root protection**: `--dangerously-skip-permissions` blocked for root/sudo (unless in sandbox)
- **Windows security**: `NoDefaultCurrentDirectoryInExePath` prevents PATH hijacking

---

## 7. Context Compaction System

### 7.1 Six-Level Progressive Compaction

| Strategy | Trigger | Mechanism |
|----------|---------|-----------|
| **Tool Result Budget** | Every turn | Truncate oversized tool results |
| **Snip Compact** | Every turn | Snip oldest history message segments |
| **Microcompact** | Every turn | Fine-grained single tool result compression |
| **Auto Compact** | Tokens > `contextWindow - 13K` | Full session summary (spawn sub-agent to generate) |
| **Reactive Compact** | API returns 413 / `prompt_too_long` | Emergency compact + retry |
| **Context Collapse** | Feature flag `CONTEXT_COLLAPSE` | Phase-based message group folding |

### 7.2 Auto Compact Circuit Breaker

Auto Compact has a **circuit breaker**: 3 consecutive failures → stop compacting to prevent infinite failure loops.

### 7.3 Snip Compact

Uses `snipCompactIfNeeded()` from `services/compact/snipCompact.js`. Snip boundary messages are yielded as signals (not data) — the replay produces equivalent boundaries. Without this, markers persist and re-trigger on every turn, causing memory leaks in long SDK sessions.

---

## 8. Command System (`commands.ts`)

### 8.1 Command Types

```typescript
type Command =
  | { type: 'prompt'; name: string; description: string; getPromptForCommand: ... }
  | { type: 'local'; name: string; description: string; action: ... }
  | { type: 'local-jsx'; name: string; description: string; render: ... }
```

#### Full Command Type Definition

```typescript
// CommandBase — shared properties
type CommandBase = {
  name: string
  aliases?: string[]
  description: string
  hasUserSpecifiedDescription?: boolean
  isEnabled?: () => boolean        // Conditional enablement (feature flags, env checks)
  isHidden?: boolean               // Hide from typeahead/help
  isMcp?: boolean
  argumentHint?: string            // Hint text displayed in gray after command
  whenToUse?: string               // Detailed usage scenarios
  version?: string
  disableModelInvocation?: boolean // Prevent model from invoking this command
  userInvocable?: boolean          // Whether users can type /command-name
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'                // Badged in autocomplete
  immediate?: boolean              // Execute immediately without waiting for stop point
  isSensitive?: boolean            // Args redacted from conversation history
  userFacingName?: () => string    // Override display name
  availability?: CommandAvailability[]  // Auth/provider gating
}

// PromptCommand — expands to text sent to the model
type PromptCommand = CommandBase & {
  type: 'prompt'
  progressMessage: string
  contentLength: number            // Characters for token estimation
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  source: 'builtin' | 'mcp' | 'plugin' | 'bundled' | SettingSource
  pluginInfo?: { pluginManifest: PluginManifest; repository: string }
  disableNonInteractive?: boolean
  hooks?: HooksSettings
  skillRoot?: string
  context?: 'inline' | 'fork'      // inline = expand in conversation, fork = sub-agent
  agent?: string                   // Agent type when forked
  effort?: EffortValue
  paths?: string[]                 // Glob patterns — only visible after model touches matching files
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>
}

// LocalCommand — executes locally, returns text/compact/skip
type LocalCommand = CommandBase & {
  type: 'local'
  supportsNonInteractive: boolean
  load(): Promise<{ call(args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> }>
}

// LocalJSXCommand — renders Ink UI components
type LocalJSXCommand = CommandBase & {
  type: 'local-jsx'
  load(): Promise<{ call(onDone: LocalJSXCommandOnDone, context, args: string): Promise<React.ReactNode> }>
}

type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

#### Command Result Types

```typescript
type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'compact'; compactionResult: CompactionResult; displayText?: string }
  | { type: 'skip' }  // Skip messages

type CommandResultDisplay = 'skip' | 'system' | 'user'

type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay
    shouldQuery?: boolean      // Send messages to model after command completes
    metaMessages?: string[]    // Additional isMeta messages (model-visible but hidden)
    nextInput?: string         // Prefill next input
    submitNextInput?: boolean  // Auto-submit next input
  }
) => void
```

#### Command Availability

```typescript
type CommandAvailability =
  | 'claude-ai'   // claude.ai OAuth subscriber
  | 'console'     // Console API key user (api.anthropic.com)

// Commands without availability = available everywhere
// Commands with availability = only shown if user matches at least one
```

### 8.2 Slash Command Parsing

```typescript
type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

function parseSlashCommand(input: string): ParsedSlashCommand | null {
  // Input: "/search foo bar" → { commandName: "search", args: "foo bar", isMcp: false }
  // Input: "/mcp:tool (MCP) arg1" → { commandName: "mcp:tool (MCP)", args: "arg1", isMcp: true }
}
```

### 8.3 Command Sources

| Source | Description | Examples |
|--------|-------------|----------|
| **Built-in** | Core commands | /help, /clear, /compact, /model |
| **Skills** | From `/skills/` directories | Custom skill commands |
| **Bundled Skills** | Shipped with the app | Pre-installed skills |
| **Plugins** | From installed plugins | Plugin-provided commands |
| **Workflows** | From workflow scripts | Automated workflows |
| **MCP** | From MCP servers | MCP-provided skills |

### 8.4 Key Commands

| Command | Type | Description |
|---------|------|-------------|
| `/help` | local-jsx | Show help |
| `/clear` | local | Clear screen |
| `/compact` | local | Compact conversation context |
| `/model` | local | Switch model |
| `/plan` | local | Toggle plan mode |
| `/cost` | local-jsx | Show session cost |
| `/status` | local-jsx | Show project status |
| `/skills` | local-jsx | Browse skills |
| `/mcp` | local | Manage MCP servers |
| `/plugin` | local | Manage plugins |
| `/vim` | local | Toggle vim mode |
| `/theme` | local | Change theme |
| `/config` | local | View/edit config |
| `/permissions` | local-jsx | Manage permissions |
| `/resume` | local-jsx | Resume session |
| `/session` | local-jsx | Session management |
| `/exit` | local | Exit application |

### 8.5 Command Loading

```
getCommands(cwd)
    ↓
loadAllCommands(cwd) — memoized by cwd
    ├── getSkills(cwd) — parallel load
    │   ├── getSkillDirCommands(cwd)
    │   ├── getPluginSkills()
    │   ├── getBundledSkills() — sync
    │   └── getBuiltinPluginSkillCommands()
    ├── getPluginCommands()
    └── getWorkflowCommands(cwd)
    ↓
meetsAvailabilityRequirement() — filter by auth/provider (claude-ai, console)
    ↓
isCommandEnabled() — filter by feature state
    ↓
Insert dynamic skills (discovered during file operations)
    ↓
Return available commands
```

### 8.6 Command Execution Flow

```
User input: "/compact"
    ↓
parseSlashCommand(input) → { commandName: "compact", args: "", isMcp: false }
    ↓
findCommand(commandName, commands) → Command
    ↓
Check command.type:
    ├── 'prompt' → getPromptForCommand(args, context) → ContentBlockParam[] → send to model
    ├── 'local' → load() → call(args, context) → LocalCommandResult
    └── 'local-jsx' → load() → call(onDone, context, args) → React.ReactNode (Ink UI)
    ↓
Process result:
    ├── { type: 'text' } → display text, optionally query model
    ├── { type: 'compact' } → compact context, display text
    └── { type: 'skip' } → no display
    ↓
onDone(result, options):
    ├── display: 'skip' | 'system' | 'user'
    ├── shouldQuery: send messages to model after command
    ├── metaMessages: insert isMeta messages
    ├── nextInput: prefill next input
    └── submitNextInput: auto-submit
```

### 8.7 Remote-Safe Commands

Commands safe in `--remote` mode (affect only local TUI state):
`/session`, `/exit`, `/clear`, `/help`, `/theme`, `/color`, `/vim`, `/cost`, `/usage`, `/copy`, `/btw`, `/feedback`, `/plan`, `/keybindings`, `/statusline`, `/stickers`, `/mobile`

### 8.8 Bridge-Safe Commands

Commands safe to execute when received over the Remote Control bridge:

```typescript
const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set([
  compact, clear, cost, summary, releaseNotes, files
])

function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false     // Ink UI stays local
  if (cmd.type === 'prompt') return true          // Expands to text, safe
  return BRIDGE_SAFE_COMMANDS.has(cmd)            // Explicit allowlist for 'local'
}
```

### 8.9 Cache Management

```typescript
// Memoization layers
COMMANDS = memoize(() => [...])                    // Built-in commands
loadAllCommands = memoize(async (cwd) => [...])    // All commands by cwd
getSkillToolCommands = memoize(async (cwd) => [...]) // Model-invocable skills
getSlashCommandToolSkills = memoize(async (cwd) => [...]) // Slash command skills

// Cache invalidation
clearCommandsCache(): void           // Full cache clear
clearCommandMemoizationCaches(): void // Only memoization, not skill caches
```

---

## 9. State Management (AppState)

### 9.1 Custom Store

~35 lines, no external dependencies, compatible with React `useSyncExternalStore`:

```typescript
interface Store<T> {
  getState(): T
  setState(updater: (prev: T) => T): void
  subscribe(listener: () => void): () => void  // returns unsubscribe function
}
```

### 9.2 AppState Core Fields

| Category | Key Fields | Description |
|----------|-----------|-------------|
| Session settings | `settings`, `mainLoopModel`, `thinkingEnabled`, `effortValue`, `fastMode` | Model and reasoning config |
| UI state | `expandedView`, `footerSelection`, `activeOverlays`, `statusLineText` | Terminal UI state |
| Permissions | `toolPermissionContext` (mode, rules, allow/deny/ask maps) | Tool permission context |
| Multi-agent | `tasks`, `teamContext`, `inbox`, `agentNameRegistry`, `foregroundedTaskId` | Task and team management |
| MCP | `mcp` (clients, tools, commands, resources) | MCP connection state |
| Bridge | `replBridge*` (enabled, connected, sessionActive, urls, errors) | Remote session state |
| Speculation | `speculation` (idle/active, abort handle, timing) | Predictive execution |
| File tracking | `fileHistory`, `todos`, `notifications` | File changes and notifications |

### 9.3 React Integration

`AppStateProvider` injects Store Context at the component tree root. Child components consume via `useContext` + selectors. Connected to React through `useSyncExternalStore`.

---

## 10. UI Architecture (Ink/React)

### 10.1 Custom Ink Engine

```
Ink class (ink/ink.tsx)
    ├── React Fiber Reconciler (custom reconciler)
    ├── Yoga Layout Engine (Flexbox layout)
    ├── Double-buffered frame rendering (front/back Frame)
    ├── Diff-based terminal writes (writeDiffToTerminal)
    ├── Event system (keyboard, mouse, focus, click)
    ├── Selection/highlight management
    ├── Alt-screen management
    └── FPS throttling scheduler
```

### 10.2 Component Hierarchy

```
FpsMetricsProvider
    └── StatsProvider
        └── AppStateProvider (Store)
            └── MailboxProvider
                └── VoiceProvider (feature-flagged)
                    └── REPL Screen (main interface)
                        ├── LogoV2 — startup logo with recent activity
                        ├── SetupScreens — onboarding wizard
                        ├── StatusBar — model, cost, git status
                        ├── MessageList
                        │   ├── Message
                        │   │   ├── UserMessage
                        │   │   ├── AssistantMessage
                        │   │   ├── ToolUseMessage (per-tool renderer)
                        │   │   ├── ToolResultMessage (per-tool renderer)
                        │   │   ├── ProgressMessage
                        │   │   └── SystemMessage
                        │   └── Spinner — loading indicator
                        ├── InputBox — user input with typeahead
                        ├── TodoPanel — task list
                        ├── CostTracker — session cost display
                        └── Keybindings — keyboard shortcuts
```

### 10.3 Dialog System

`showDialog(root, renderer)` — Promise-based universal dialog mechanism. `dialogLaunchers.tsx` provides specialized dialog launchers (settings, trust, snapshot update, etc.), each using dynamic import for lazy loading.

### 10.4 Terminal Control

```typescript
import { SHOW_CURSOR, HIDE_CURSOR } from './ink/termio/dec.js'
import { render, type Root } from './ink.js'
process.title = 'claude'
```

---

## 10.5 Keybinding System

### 10.5.1 Architecture

```
keybindings/
├── defaultBindings.ts    — Default shortcuts (340 lines, 18 contexts)
├── reservedShortcuts.ts  — Non-rebindable reserved shortcuts
├── schema.ts             — Zod validation + JSON Schema generation
├── useKeybinding.ts      — React Hook (Ink-native key handler)
├── parser.ts             — Keystroke string parsing
├── resolver.ts           — Context priority resolution
├── match.ts              — Key matching logic
├── validate.ts           — User config validation
├── template.ts           — Config template generation
├── loadUserBindings.ts   — Load user keybindings.json
├── shortcutFormat.ts     — Shortcut display formatting
├── useShortcutDisplay.ts — Shortcut display Hook
├── KeybindingContext.tsx — Context Provider
└── KeybindingProviderSetup.tsx — Provider initialization
```

### 10.5.2 Context Priority System

Keybindings are organized into **18 contexts**, resolved by priority:

```
Registered active contexts > Current context > Global
```

More specific contexts take precedence. Global bindings are the fallback.

### 10.5.3 All 18 Contexts

| Context | Description | Key Shortcuts |
|---------|-------------|---------------|
| **Global** | Active everywhere | `ctrl+c` interrupt, `ctrl+d` exit, `ctrl+l` redraw, `ctrl+t` toggle todos, `ctrl+o` toggle transcript, `ctrl+r` history search |
| **Chat** | Input box focused | `esc` cancel, `enter` submit, `↑/↓` history, `meta+p` model picker, `meta+t` thinking toggle, `ctrl+s` stash, `ctrl+g` external editor |
| **Autocomplete** | Autocomplete menu | `tab` accept, `esc` dismiss, `↑/↓` navigate |
| **Confirmation** | Confirmation/permission dialogs | `y` yes, `n` no, `enter` yes, `esc` no, `shift+tab` cycle mode |
| **Select** | Select/list components | `↑/↓/j/k/ctrl+n/ctrl+p` navigate, `enter` accept, `esc` cancel |
| **Settings** | Settings menu | `enter` save+close, `/` search, `space` toggle, `j/k` navigate |
| **Transcript** | Conversation history viewer | `q/esc/ctrl+c` exit, `ctrl+e` show all |
| **HistorySearch** | History search (ctrl+r) | `ctrl+r` next, `enter` execute, `esc/tab` accept |
| **Tabs** | Tab switching | `tab` next, `shift+tab` previous, `←/→` switch |
| **Task** | Task running in foreground | `ctrl+b` send to background |
| **Scroll** | Scrolling | `pageup/pagedown`, `ctrl+shift+c` copy, `cmd+c` copy |
| **Help** | Help panel | `esc` dismiss |
| **Attachments** | Image attachment navigation | `←/→` switch, `backspace/delete` remove |
| **Footer** | Footer indicator navigation | `↑/↓` navigate, `enter` open |
| **MessageSelector** | Message rewind selector | `↑/↓/j/k` navigate, `shift+↑/↓` jump to user messages |
| **DiffDialog** | Diff comparison dialog | `←/→` switch source, `↑/↓` switch file |
| **ModelPicker** | Model effort cycling (ant-only) | `←/→` adjust effort |
| **Plugin** | Plugin management dialog | `space` toggle, `i` install |

### 10.5.4 Chord Sequences (Multi-step Keys)

```
'ctrl+x ctrl+k' → chat:killAgents
'ctrl+x ctrl+e' → chat:externalEditor  (readline-native binding)
```

The system automatically manages pending chord state. When a chord prefix is detected, subsequent keys are matched against the chord sequence. `escape` cancels the pending chord.

### 10.5.5 Non-Rebindable Shortcuts

| Shortcut | Reason | Severity |
|----------|--------|----------|
| `ctrl+c` | Interrupt/exit (hardcoded) | Error |
| `ctrl+d` | Exit (hardcoded) | Error |
| `ctrl+m` | Identical to Enter in terminals (both send CR) | Error |

### 10.5.6 Terminal-Reserved Shortcuts

| Shortcut | Reason | Severity |
|----------|--------|----------|
| `ctrl+z` | Unix process suspend (SIGTSTP) | Warning |
| `ctrl+\` | Terminal quit signal (SIGQUIT) | Error |

### 10.5.7 Platform-Specific Adaptation

```typescript
// Image paste: Windows vs others
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// Mode cycle: VT mode support detection
const SUPPORTS_TERMINAL_VT_MODE =
  getPlatform() !== 'windows' ||
  (isRunningWithBun()
    ? satisfies(process.versions.bun, '>=1.2.23')
    : satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0'))
const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'
```

### 10.5.8 User Customization

Users customize via `~/.claude/keybindings.json`:

```json
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+k": "chat:submit",
        "ctrl+c": null
      }
    }
  ]
}
```

- Set to `null` to unbind a default shortcut
- Supports `command:help` format to invoke slash commands directly
- Validated against Zod schema with reserved shortcut warnings

### 10.5.9 React Hook Integration

```tsx
// Single keybinding
useKeybinding('app:toggleTodos', () => {
  setShowTodos(prev => !prev)
}, { context: 'Global' })

// Multiple keybindings (reduces useInput calls)
useKeybindings({
  'chat:submit': () => handleSubmit(),
  'chat:cancel': () => handleCancel(),
}, { context: 'Chat' })
```

Handler returning `false` means "not consumed" — event propagates to later handlers. Supports `Promise<void>` for fire-and-forget async handlers.

### 10.5.10 Keybinding Resolution Flow

```
Keypress event
    ↓
useInput handler
    ↓
keybindingContext.resolve(input, key, contextsToCheck)
    ├── match → execute handler, stopImmediatePropagation
    ├── chord_started → update pending state, stopImmediatePropagation
    ├── chord_cancelled → clear pending state (escape)
    ├── unbound → clear pending, stopImmediatePropagation
    └── none → let other handlers try
    ↓
Context priority: activeContexts > current context > Global
```

---

## 11. MCP Integration

### 11.1 Architecture

```
Config sources (multi-level merge)
    ├── .mcp.json (project-level)
    ├── ~/.claude/... (user-level)
    ├── Enterprise managed path
    └── Plugin dynamic injection
            │
            ▼
    getAllMcpConfigs() → merge and deduplicate
            │
            ▼
    MCPConnectionManager
    ┌─────────────────────────────┐
    │  8 transport protocols:      │
    │  stdio │ sse │ sse-ide       │
    │  ws-ide │ http │ ws          │
    │  sdk │ claudeai-proxy        │
    │                              │
    │  Connection states:          │
    │  connected │ failed          │
    │  needs-auth │ pending        │
    │  disabled                    │
    └──────────┬──────────────────┘
               │
               ▼
    MCPTool instances (proxy remote tools)
    + Resources (readable resources)
    + Commands (slash command extensions)
```

### 11.2 Configuration Sources

| Source | Scope |
|--------|-------|
| `.mcp.json` | Project-level |
| `~/.claude/settings.json` | Global user |
| `CLAUDE_MCP_CONFIGS` env var | Environment |
| MCP serve command | CLI |
| Claude.ai synced configs | Cloud |
| Enterprise managed path | Organization |
| Plugin injection | Dynamic |

---

## 12. Bridge Mode (Remote Sessions)

Supports driving local CLI instances from claude.ai or other remote clients:

```
claude.ai / Remote client
        │ WebSocket
        ▼
bridgeMain.ts → runBridgeLoop()
    ├── Register Bridge environment
    ├── Poll work items (sessions / healthchecks)
    ├── Three spawn modes:
    │   ├── single-session (single session)
    │   ├── worktree (Git worktree isolation)
    │   └── same-dir (shared working directory)
    ├── Exponential backoff reconnect (2s initial, 2min cap, 10min give up)
    └── System sleep/wake detection
```

---

## 13. Memory System (memdir)

### 13.1 Storage

| System | Location | Format | Purpose |
|--------|----------|--------|---------|
| **History** | `~/.claude/history.jsonl` | JSONL (append, max 100 entries) | Command history, ↑/Ctrl+R search |
| **Memory (memdir)** | `~/.claude/projects/<root>/memory/` | Markdown + YAML frontmatter | Cross-session persistent memory (4 types) |
| **Session Memory** | `~/.claude/.../session-memory/` | Structured Markdown | In-session auto-summaries |
| **Config** | `~/.claude/settings.json` + `.claude/settings.json` | JSON | User/project configuration |
| **CLAUDE.md** | Project root + `~/.claude/` | Markdown | Project context instructions |
| **Transcript** | Session storage | JSONL | Full conversation transcript |

### 13.2 Memory Types

| Type | Description |
|------|-------------|
| **user** | User preferences and working style |
| **feedback** | Corrections and feedback given |
| **project** | Project-specific knowledge |
| **reference** | Reference materials and patterns |

### 13.3 Memory System Security

- Path validation rejects relative paths, root paths, UNC paths, null bytes
- Git worktrees share the same memory directory (resolved via canonical git root)
- Project-level settings cannot override memory paths (injection prevention)

### 13.4 Session Memory

Auto-generated structured Markdown summaries: title, status, tasks, files, workflows, errors, learnings.

---

## 14. Skills System

### 14.1 Skill Discovery

```
Skill sources
    ├── Disk skills (Markdown .md files)
    │   ├── ~/.claude/skills/ (user-level)
    │   ├── .claude/skills/ (project-level)
    │   └── Enterprise managed / Plugin paths
    │
    ├── Bundled skills (bundledSkills.ts)
    │   └── Compiled into binary, registerBundledSkill()
    │
    └── MCP skills (mcpSkillBuilders.ts)
        └── Dynamically loaded from MCP server metadata
```

### 14.2 Skill Structure (Markdown with frontmatter)

```yaml
---
name: skill-name
description: What this skill does
when-to-use: When the model should invoke it
allowed-tools: [Bash, FileRead, ...]
model: optional model override
hooks: optional hooks
paths: optional path patterns
effort: effort level
shell: shell requirements
context: fork | inline
agent: agent configuration
user-invocable: whether users can trigger directly
---
```

**Parameter substitution**: `$ARGUMENTS`, `$ARG1`, `$ARG2`...

**Execution**: `SkillTool → runAgent()` sub-agent executes with parameter replacement.

---

## 15. Task System

### 15.1 Task Types

```typescript
type TaskType =
  | 'local_bash'          // Background shell process
  | 'local_agent'         // Local sub-agent process
  | 'remote_agent'        // Remote agent
  | 'in_process_teammate' // In-process agent (Agent Swarm)
  | 'local_workflow'      // Workflow script
  | 'monitor_mcp'         // MCP monitor
  | 'dream'               // Background reasoning

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

### 15.2 Task Implementations

| Task Type | Implementation | Description |
|-----------|---------------|-------------|
| LocalShellTask | Background shell process | BashTool's `run_in_background` |
| LocalAgentTask | Local sub-agent process | AgentTool spawning |
| RemoteAgentTask | Remote agent | Remote execution |
| InProcessTeammateTask | In-process agent | Agent Swarm member |
| DreamTask | Background reasoning | Background thinking task |

### 15.3 Task ID Format

`<type_prefix><8 random chars>` (e.g., `b0a3f2x1k`), using case-insensitive alphabet to prevent symlink attacks.

---

## 16. Hooks System

### 16.1 Hook Types

| Hook | Trigger | Purpose |
|------|---------|---------|
| `SessionStart` | Session begins | Setup, initialization |
| `PreToolUse` | Before tool execution | Validation, modification |
| `PostToolUse` | After tool execution | Cleanup, logging |
| `FileChanged` | File system change detection | Hot reload, re-indexing |
| `PreCompact` | Before context compaction | Save state |
| `PostCompact` | After context compaction | Restore state |

### 16.2 Hook Configuration

```json
{
  "hooks": {
    "SessionStart": {
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "echo 'session started'" }]
    },
    "PreToolUse": {
      "matcher": "Bash(rm *)",
      "hooks": [{ "type": "command", "command": "echo 'deleting: $1'" }]
    }
  }
}
```

---

## 17. Key Data Flows

### 17.1 Complete Query Flow

```
User input (Terminal / IDE / Web / SDK)
     │
     ▼
REPL captures input
     │
     ├── Slash command? ──▶ Commands system (/commit, /compact, etc.)
     │
     └── Natural language ──▶ QueryEngine.submitMessage()
                                  │
                                  ├── Assemble SystemPrompt
                                  │   ├── CLAUDE.md content
                                  │   ├── Git status context
                                  │   ├── Auto memory (memdir)
                                  │   ├── Tool descriptions (tools[].prompt())
                                  │   └── MCP resources
                                  │
                                  ├── query() loop
                                  │   ├── → Claude API (streaming)
                                  │   ├── ← Model response (text + tool_use)
                                  │   ├── → Permission check → Tool execution
                                  │   ├── ← Tool results
                                  │   └── Loop until end_turn
                                  │
                                  ▼
                          UI renders response
                          ├── Text streaming output
                          ├── Tool call display (diff, commands, search results)
                          ├── Permission dialogs (if needed)
                          └── Cost/token statistics update
```

### 17.2 Tool Execution Flow

```
API returns tool_use content block
    ↓
findToolByName(tools, toolName)
    ↓
validateInput(input, context)
    ↓
checkPermissions(input, context)
    ↓
canUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)
    ├── Check alwaysDeny rules
    ├── Check alwaysAllow rules
    ├── Check alwaysAsk rules
    ├── Run PreToolUse hooks
    ├── Auto-mode classifier (if enabled)
    └── Show permission dialog (if needed)
    ↓
tool.call(input, context, canUseTool, parentMessage, onProgress)
    ↓
ToolResult<Output>
    ↓
mapToolResultToToolResultBlockParam()
    ↓
Send result back to API
```

---

## 18. Performance Optimizations

### 18.1 Startup Profiling

```typescript
profileCheckpoint('main_tsx_entry')
profileCheckpoint('main_tsx_imports_loaded')
profileCheckpoint('main_function_start')
profileCheckpoint('main_warning_handler_initialized')
profileCheckpoint('main_client_type_determined')
profileCheckpoint('main_before_run')
profileCheckpoint('main_after_run')
```

### 18.2 Parallel Prefetch

```typescript
// Module-level parallel prefetches (run during imports)
startMdmRawRead()        // MDM settings subprocess
startKeychainPrefetch()  // Keychain reads
preconnectAnthropicApi() // API preconnection

// Deferred prefetches (after first render)
initUser()
getUserContext()
prefetchSystemContextIfSafe()
getRelevantTips()
prefetchAwsCredentialsAndBedRockInfoIfSafe()
prefetchGcpCredentialsIfSafe()
countFilesRoundedRg()
initializeAnalyticsGates()
prefetchOfficialMcpUrls()
refreshModelCapabilities()
settingsChangeDetector.initialize()
skillChangeDetector.initialize()
```

### 18.3 Lazy Loading

- REPL components via dynamic `import()`
- OpenTelemetry (~400KB) + gRPC (~700KB) lazy-loaded
- Dialog launchers via dynamic import
- Subcommands via lazy require

### 18.4 Memoization

```typescript
const COMMANDS = memoize((): Command[] => [...])
const getCommands = memoize(async (cwd: string): Promise<Command[]> => [...])
const getSkillToolCommands = memoize(async (cwd: string): Promise<Command[]> => [...])
const getSlashCommandToolSkills = memoize(async (cwd: string): Promise<Command[]> => [...])
```

### 18.5 Dead Code Elimination

```typescript
// Feature-flagged conditional imports — modules completely excluded from bundle
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js')
  : null

// Ant-only tools (removed in external builds)
const REPLTool = process.env.USER_TYPE === 'ant'
  ? require('./tools/REPLTool/REPLTool.js').REPLTool
  : null
```

---

## 19. Security Architecture

### 19.1 Defense Layers

1. **Permission System**: alwaysAllow/alwaysDeny/alwaysAsk rules with multi-source priority
2. **Tool Validation**: `validateInput()` per tool
3. **Hook Gates**: PreToolUse hooks can block execution
4. **Auto-mode Classifier**: ML-based security classification
5. **Sandbox**: Docker/Bubblewrap isolation for dangerous operations
6. **Root Protection**: `--dangerously-skip-permissions` blocked for root/sudo
7. **Windows Security**: `NoDefaultCurrentDirectoryInExePath` prevents PATH hijacking
8. **System Context Safety**: Git commands only run after trust established
9. **Filesystem Protection**: Sensitive paths (.gitconfig, .bashrc, .claude/) auto-intercepted
10. **Memory Path Injection Protection**: Project settings cannot override memory paths

### 19.2 Trust Model

```
First run → Trust dialog → User accepts → System context prefetch enabled
Subsequent runs → Trust already confirmed → Full functionality
```

### 19.3 Fail-Closed Defaults

- Tools default to `isReadOnly=false`, `isConcurrencySafe=false`
- Permission system defaults to `ask` when no rule matches
- Auto-mode classifier: default to undercover ON until proven internal

---

## 20. Extensibility Points

| Extension Point | Mechanism | Location |
|----------------|-----------|----------|
| **New Tools** | Implement `Tool` interface + register in `tools.ts` | `tools/` |
| **New Commands** | Implement `Command` type + register in `commands.ts` | `commands/` |
| **Skills** | Create `/skills/` directory with Markdown files | Project or global |
| **Plugins** | Install via `/plugin install` | `~/.claude/plugins/` |
| **Hooks** | Configure in `settings.json` | `.claude/` or `~/.claude/` |
| **MCP Servers** | Configure in `settings.json` or `CLAUDE.md` | Various |
| **Custom Agents** | JSON definition in agents directory | `~/.claude/agents/` |
| **Themes** | Configure in `settings.json` | `~/.claude/settings.json` |
| **Workflows** | Workflow scripts with feature flag | `tools/WorkflowTool/bundled/` |

---

## 21. File Structure Summary

```
claude-src/
├── main.tsx                    # Entry point, CLI setup, feature flags
├── setup.ts                    # Session initialization
├── QueryEngine.ts              # AI query engine (headless/SDK)
├── Tool.ts                     # Tool interface and types (792 lines)
├── tools.ts                    # Tool registry and assembly (389 lines)
├── commands.ts                 # Command registry and loading (754 lines)
├── replLauncher.tsx            # REPL launcher
├── context.ts                  # System/user context
├── history.ts                  # Conversation history
├── cost-tracker.ts             # Session cost tracking
├── ink.ts                      # Ink/React rendering
│
├── entrypoints/                # Entry point modules
│   └── init.ts                 # Initialization (config, auth, telemetry)
│
├── api/                        # API layer
│   └── claude.ts               # Anthropic API client (streaming/non-streaming)
│
├── tools/                      # Tool implementations (40+ tools)
│   ├── BashTool/
│   ├── FileReadTool/
│   ├── FileEditTool/
│   ├── FileWriteTool/
│   ├── AgentTool/
│   ├── SkillTool/
│   └── ... (43 directories)
│
├── commands/                   # Command implementations (60+ commands)
│   ├── help/
│   ├── clear/
│   ├── compact/
│   ├── model/
│   ├── mcp/
│   └── ...
│
├── components/                 # React/Ink UI components
├── screens/                    # Screen components (REPL, etc.)
├── state/                      # Custom Store state management
├── services/                   # Service layer
│   ├── api/                    # API clients
│   ├── mcp/                    # MCP server management
│   ├── lsp/                    # LSP integration
│   ├── oauth/                  # Authentication
│   ├── analytics/              # Telemetry and analytics
│   ├── compact/                # Context compaction strategies
│   └── ...
├── utils/                      # Utilities (permissions, settings, git, etc.)
├── types/                      # TypeScript type definitions
├── hooks/                      # Hook system
├── plugins/                    # Plugin system
├── skills/                     # Skill system
├── coordinator/                # Multi-agent coordinator
├── assistant/                  # Assistant mode (KAIROS)
├── server/                     # Server components
├── remote/                     # Remote session support
├── bridge/                     # Bridge mode (remote control)
├── migrations/                 # Data migrations (11 migrations)
├── bootstrap/                  # Bootstrap state
├── memdir/                     # Memory directory system
├── query/                      # Query utilities
├── schemas/                    # Validation schemas
├── dialogLaunchers.tsx         # Dialog system
├── keybindings/                # Keyboard shortcut system
├── vim/                        # Vim mode
├── voice/                      # Voice interaction
└── outputStyles/               # Output styling
```

---

*Document generated from source analysis + cross-reference analysis. All paths, types, and structures reflect the actual codebase at analysis time.*
