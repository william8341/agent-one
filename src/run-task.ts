/**
 * Shared single-shot agent run for CLI / background worker.
 */
import { Agent } from "./agent.js";
import {
  LlmClient,
  PROVIDER_PRESETS,
  loadCustomModels,
  customModelToProvider,
  hasEffectiveCloudApiKeys,
  effectiveOpenAiApiKeyFromEnv,
  effectiveAnthropicApiKeyFromEnv,
} from "./llm.js";
import { ToolRegistry, registerBuiltinTools } from "./tools.js";
import { loadSkills } from "./skills.js";
import type { ProviderConfig, ProviderType, CustomModelEntry } from "./types.js";

export function resolveProviderFromEnvAndModel(
  model: string | undefined,
  customModels: CustomModelEntry[],
): ProviderConfig {
  const modelEnv = process.env.OPENAI_MODEL ?? process.env.MODEL;
  const typeEnv = (process.env.PROVIDER_TYPE ?? "openai") as ProviderType;

  if (modelEnv && PROVIDER_PRESETS[modelEnv]) {
    const preset = PROVIDER_PRESETS[modelEnv];
    return {
      ...preset,
      apiKey:
        preset.type === "anthropic"
          ? effectiveAnthropicApiKeyFromEnv()
          : effectiveOpenAiApiKeyFromEnv(),
    } as ProviderConfig;
  }

  let apiKey: string | undefined;
  if (typeEnv === "anthropic") {
    apiKey = effectiveAnthropicApiKeyFromEnv();
  } else if (typeEnv !== "ollama") {
    apiKey = effectiveOpenAiApiKeyFromEnv();
  }

  const baseUrl =
    process.env.OPENAI_BASE_URL ??
    (typeEnv === "anthropic"
      ? "https://api.anthropic.com"
      : typeEnv === "ollama"
        ? "http://localhost:11434/v1"
        : "https://api.openai.com/v1");

  const resolvedModel =
    modelEnv ?? (typeEnv === "anthropic" ? "claude-sonnet-4-6-20250414" : "gpt-4.1-mini");

  return { type: typeEnv, apiKey, baseUrl, model: resolvedModel };
}

export async function buildProviderForCli(
  cwd: string,
  model: string | undefined,
): Promise<ProviderConfig> {
  const customModels = await loadCustomModels(cwd);

  if (model) {
    const customMatch = customModels.find(
      (m) => m.id === model || m.id.toLowerCase() === model.toLowerCase(),
    );
    if (customMatch) {
      return customModelToProvider(customMatch);
    }
    const preset = PROVIDER_PRESETS[model];
    const envProvider = resolveProviderFromEnvAndModel(undefined, customModels);
    if (preset) {
      return { ...preset, apiKey: envProvider.apiKey } as ProviderConfig;
    }
    return { ...envProvider, model };
  }

  // Only treat env as authoritative when cloud keys are set. Otherwise
  // OPENAI_MODEL / PROVIDER_TYPE alone must NOT skip custom-models.json.
  if (hasEffectiveCloudApiKeys()) {
    return resolveProviderFromEnvAndModel(undefined, customModels);
  }

  if (customModels.length > 0) {
    return customModelToProvider(customModels[0]!);
  }

  return resolveProviderFromEnvAndModel(undefined, customModels);
}

/** Whether this provider cannot work without an API key */
function providerMissingRequiredKey(provider: ProviderConfig): boolean {
  if (provider.type === "ollama") return false;
  if (provider.apiKey) return false;
  if (provider.type === "anthropic" || provider.type === "openrouter") return true;
  if (provider.type === "openai") {
    const h = (provider.baseUrl ?? "").toLowerCase();
    if (h.includes("api.openai.com")) return true;
    return false;
  }
  return false;
}

export async function runAgentTask(
  prompt: string,
  cwd: string,
  model: string | undefined,
): Promise<string> {
  const provider = await buildProviderForCli(cwd, model);
  const skills = await loadSkills(cwd);

  if (providerMissingRequiredKey(provider)) {
    const keyName = provider.type === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    throw new Error(
      `Missing ${keyName}. Set it in environment, custom-models.json (apiKey), ~/.agent-one/config.toml, or run: agent-one login`,
    );
  }

  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const llm = new LlmClient(provider);
  const agent = new Agent(llm, registry, skills, { cwd });
  return agent.run(prompt);
}
