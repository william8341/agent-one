import type { ZodType } from "zod";

// ─── LLM Types ───────────────────────────────────────────────────────────
export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface LlmStreamEvent {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "done" | "error";
  text?: string;
  toolCall?: LlmToolCall;
  usage?: LlmResponse["usage"];
  error?: string;
}

// ─── Provider Config ─────────────────────────────────────────────────────
export type ProviderType = "openai" | "anthropic" | "ollama" | "openrouter";

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

// ─── Custom Model Entry (from custom-models.json) ────────────────────────
export interface CustomModelEntry {
  id: string;
  value: string;
  label: string;
  description?: string;
  provider: string;
  baseURL: string;
  apiKey?: string;
}

// ─── Tool Types ──────────────────────────────────────────────────────────
export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  isReadOnly?: boolean;
  execute(args: I, ctx: ToolContext): Promise<ToolResult>;
}

// ─── Skill Types ─────────────────────────────────────────────────────────
export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  systemPrompt: string;
}

// ─── Agent Types ─────────────────────────────────────────────────────────
export interface AgentOptions {
  cwd: string;
  maxTurns?: number;
  systemPrompt?: string;
}

// ─── Session & State ─────────────────────────────────────────────────────
export type SessionStatus = "idle" | "thinking" | "tool_running" | "streaming" | "error";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UIMessage {
  id: string;
  role: LlmRole;
  content: string;
  toolName?: string;
  toolCallId?: string;
  timestamp: number;
  isStreaming?: boolean;
  isError?: boolean;
}

export interface AppState {
  status: SessionStatus;
  messages: UIMessage[];
  provider: ProviderConfig;
  usage: TokenUsage;
  inputHistory: string[];
  historyIndex: number;
  showPermission: PermissionRequest | null;
  errorMessage: string | null;
}

// ─── Permission ──────────────────────────────────────────────────────────
export interface PermissionRequest {
  toolName: string;
  args: unknown;
  resolve: (allowed: boolean) => void;
}

// ─── Command (slash commands) ────────────────────────────────────────────
export interface SlashCommand {
  name: string;
  description: string;
  execute(args: string, ctx: CommandContext): Promise<string | null>;
}

export interface CommandContext {
  setState: (fn: (s: AppState) => AppState) => void;
  getState: () => AppState;
  providers: ProviderConfig[];
  customModels: CustomModelEntry[];
}
