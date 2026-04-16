/**
 * Multi-provider LLM client — supports OpenAI-compatible, Anthropic, Ollama.
 * Streaming + non-streaming, retry with exponential backoff.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ProviderConfig,
  ProviderType,
  CustomModelEntry,
  LlmMessage,
  LlmResponse,
  LlmStreamEvent,
  LlmToolCall,
} from "./types.js";

// ─── OpenAI-format tool schema ───────────────────────────────────────────
interface OpenAIToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

// ─── Retry config ────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Provider Adapters ───────────────────────────────────────────────────

/**
 * OpenAI-compatible (OpenAI, DeepSeek, vLLM, LiteLLM, etc.)
 */
async function completeOpenAI(
  config: ProviderConfig,
  messages: LlmMessage[],
  tools: OpenAIToolSchema[],
): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_calls) out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsText },
      }));
      return out;
    }),
    temperature: config.temperature ?? 0.2,
    max_tokens: config.maxTokens ?? 8192,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }> } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const msg = data.choices?.[0]?.message;
  const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? []).map((t) => ({
    id: t.id,
    name: t.function.name,
    argumentsText: t.function.arguments ?? "{}",
  }));

  return {
    content: msg?.content ?? "",
    toolCalls,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * OpenAI-compatible streaming
 */
async function* streamOpenAI(
  config: ProviderConfig,
  messages: LlmMessage[],
  tools: OpenAIToolSchema[],
): AsyncGenerator<LlmStreamEvent> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_calls) out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsText },
      }));
      return out;
    }),
    temperature: config.temperature ?? 0.2,
    max_tokens: config.maxTokens ?? 8192,
    stream: true,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.body) {
    yield { type: "error", error: "No response body for streaming" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          // Flush accumulated tool calls
          for (const [, tc] of toolCallAccumulators) {
            yield {
              type: "tool_call_start",
              toolCall: { id: tc.id, name: tc.name, argumentsText: tc.args },
            };
          }
          yield { type: "done" };
          return;
        }
        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; tool_calls?: Array<{
              index: number; id?: string; function?: { name?: string; arguments?: string };
            }> } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: "text_delta", text: delta.content };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              let acc = toolCallAccumulators.get(tc.index);
              if (!acc) {
                acc = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
                toolCallAccumulators.set(tc.index, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
          if (chunk.usage) {
            yield {
              type: "done",
              usage: {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                totalTokens: chunk.usage.total_tokens ?? 0,
              },
            };
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }
    // Flush remaining tool calls
    for (const [, tc] of toolCallAccumulators) {
      yield {
        type: "tool_call_start",
        toolCall: { id: tc.id, name: tc.name, argumentsText: tc.args },
      };
    }
    yield { type: "done" };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Anthropic Messages API
 */
async function completeAnthropic(
  config: ProviderConfig,
  messages: LlmMessage[],
  tools: OpenAIToolSchema[],
): Promise<LlmResponse> {
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  // Convert messages to Anthropic format
  const anthropicMessages = nonSystem.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: m.tool_call_id, content: m.content }],
      };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant" as const,
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.tool_calls.map((tc) => ({
            type: "tool_use" as const,
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.argumentsText || "{}"),
          })),
        ],
      };
    }
    return { role: m.role as "user" | "assistant", content: m.content };
  });

  // Convert tools to Anthropic format
  const anthropicTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens ?? 8192,
    messages: anthropicMessages,
  };
  if (systemMsg) body.system = systemMsg.content;
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  const res = await fetchWithRetry(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  let text = "";
  const toolCalls: LlmToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `tc_${Date.now()}`,
        name: block.name ?? "",
        argumentsText: JSON.stringify(block.input ?? {}),
      });
    }
  }

  return {
    content: text,
    toolCalls,
    usage: data.usage
      ? {
          promptTokens: data.usage.input_tokens ?? 0,
          completionTokens: data.usage.output_tokens ?? 0,
          totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        }
      : undefined,
  };
}

/**
 * Ollama — uses OpenAI-compatible endpoint
 */
async function completeOllama(
  config: ProviderConfig,
  messages: LlmMessage[],
  tools: OpenAIToolSchema[],
): Promise<LlmResponse> {
  return completeOpenAI(config, messages, tools);
}

// ─── Fetch with retry ────────────────────────────────────────────────────
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429) {
        const wait = RETRY_BASE_MS * Math.pow(2, i);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
      }
      return res;
    } catch (err) {
      lastErr = err as Error;
      if (i < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_MS * Math.pow(2, i));
      }
    }
  }
  throw lastErr ?? new Error("LLM request failed after retries");
}

// ─── Public Client Class ─────────────────────────────────────────────────
export class LlmClient {
  constructor(public readonly config: ProviderConfig) {}

  async complete(messages: LlmMessage[], tools: OpenAIToolSchema[]): Promise<LlmResponse> {
    switch (this.config.type) {
      case "anthropic":
        return completeAnthropic(this.config, messages, tools);
      case "ollama":
        return completeOllama(this.config, messages, tools);
      case "openai":
      case "openrouter":
      default:
        return completeOpenAI(this.config, messages, tools);
    }
  }

  async *stream(messages: LlmMessage[], tools: OpenAIToolSchema[]): AsyncGenerator<LlmStreamEvent> {
    // Streaming supports OpenAI-compatible providers (including openrouter, ollama)
    yield* streamOpenAI(this.config, messages, tools);
  }
}

// ─── Env API keys (ignore placeholders that would hit OpenAI with Bearer "ollama") ─

const PLACEHOLDER_API_KEYS = new Set([
  "ollama",
  "none",
  "dummy",
  "placeholder",
  "sk-placeholder",
  "changeme",
  "your-api-key",
]);

export function isPlaceholderApiKeyValue(key: string | undefined): boolean {
  const k = key?.trim().toLowerCase();
  if (!k) return true;
  return PLACEHOLDER_API_KEYS.has(k);
}

/** Treat empty / common dummy values as “no key” so custom-models.json is not skipped. */
export function effectiveOpenAiApiKeyFromEnv(): string | undefined {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (!k || isPlaceholderApiKeyValue(k)) return undefined;
  return k;
}

export function effectiveAnthropicApiKeyFromEnv(): string | undefined {
  const k = process.env.ANTHROPIC_API_KEY?.trim();
  if (!k || isPlaceholderApiKeyValue(k)) return undefined;
  return k;
}

/** Real cloud credentials in env (not placeholders). */
export function hasEffectiveCloudApiKeys(): boolean {
  return Boolean(effectiveOpenAiApiKeyFromEnv() || effectiveAnthropicApiKeyFromEnv());
}

// ─── Custom Models Loader ────────────────────────────────────────────────

/** Map a custom-models.json provider string to our internal ProviderType */
function mapProviderType(provider: string): ProviderType {
  const p = provider.toLowerCase();
  if (p === "anthropic") return "anthropic";
  if (p === "ollama") return "ollama";
  if (p === "openrouter") return "openrouter";
  return "openai";
}

/** Normalise baseURL — Ollama needs /v1, OpenRouter needs /v1 */
function normaliseBaseUrl(baseURL: string, providerType: ProviderType): string {
  let url = baseURL.replace(/\/+$/, ""); // strip trailing slashes
  if (providerType === "ollama" && !url.endsWith("/v1")) {
    url += "/v1";
  }
  if (providerType === "openrouter" && !url.endsWith("/v1")) {
    url += "/v1";
  }
  return url;
}

/** Convert a CustomModelEntry to a ProviderConfig */
export function customModelToProvider(entry: CustomModelEntry): ProviderConfig {
  const type = mapProviderType(entry.provider);
  let apiKey = entry.apiKey;
  if (type === "ollama") {
    if (!apiKey?.trim() || isPlaceholderApiKeyValue(apiKey)) {
      apiKey = undefined;
    }
  }
  return {
    type,
    model: entry.value,
    baseUrl: normaliseBaseUrl(entry.baseURL, type),
    apiKey,
  };
}

/**
 * Load custom-models.json from cwd (or project root).
 * Returns empty array if file doesn't exist.
 */
export async function loadCustomModels(cwd: string): Promise<CustomModelEntry[]> {
  const filePath = resolve(cwd, "custom-models.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { models?: CustomModelEntry[] };
    return data.models ?? [];
  } catch {
    return [];
  }
}

// ─── Provider Presets ────────────────────────────────────────────────────
export const PROVIDER_PRESETS: Record<string, Omit<ProviderConfig, "apiKey">> = {
  "gpt-4.1": { type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" },
  "gpt-4.1-mini": { type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  "gpt-4.1-nano": { type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-nano" },
  "claude-sonnet-4-6": { type: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6-20250414" },
  "claude-opus-4-6": { type: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-4-6-20250414" },
  "claude-haiku-4-5": { type: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5-20251001" },
  "deepseek-chat": { type: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  "deepseek-reasoner": { type: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner" },
  "ollama/llama3": { type: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3" },
  "ollama/qwen2.5": { type: "ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5" },
  "ollama/deepseek-r1": { type: "ollama", baseUrl: "http://localhost:11434/v1", model: "deepseek-r1" },
};
