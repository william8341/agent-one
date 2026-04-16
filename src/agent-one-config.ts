/**
 * ~/.agent-one/config.toml — minimal key=value parsing (no external deps).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_ONE_DIR = path.join(os.homedir(), ".agent-one");
export const AGENT_ONE_CONFIG_PATH = path.join(AGENT_ONE_DIR, "config.toml");

export type AgentOneConfig = {
  api_key?: string;
  provider_type?: "openai" | "anthropic" | "ollama";
  model?: string;
  default_timeout?: number;
  output_format?: "markdown" | "json" | "plain";
};

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function loadAgentOneConfig(): AgentOneConfig {
  if (!fs.existsSync(AGENT_ONE_CONFIG_PATH)) return {};
  const text = fs.readFileSync(AGENT_ONE_CONFIG_PATH, "utf8");
  const out: AgentOneConfig = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let raw = trimmed.slice(eq + 1).trim();
    raw = stripQuotes(raw);
    switch (key) {
      case "api_key":
        out.api_key = raw;
        break;
      case "provider_type":
        if (raw === "openai" || raw === "anthropic" || raw === "ollama") {
          out.provider_type = raw;
        }
        break;
      case "model":
        out.model = raw;
        break;
      case "default_timeout": {
        const n = Number(raw);
        if (!Number.isNaN(n)) out.default_timeout = n;
        break;
      }
      case "output_format":
        if (raw === "markdown" || raw === "json" || raw === "plain") {
          out.output_format = raw;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function saveApiKeyToConfig(apiKey: string, providerType: "openai" | "anthropic"): void {
  fs.mkdirSync(AGENT_ONE_DIR, { recursive: true });
  const escaped = apiKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const body = `api_key = "${escaped}"\nprovider_type = "${providerType}"\n`;
  fs.writeFileSync(AGENT_ONE_CONFIG_PATH, body, "utf8");
}

/** Apply config to process.env for downstream provider resolution (does not overwrite existing env). */
export function applyConfigToEnv(cfg: AgentOneConfig): void {
  if (!cfg.api_key) return;
  if (cfg.provider_type === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.api_key;
  } else if (cfg.provider_type === "ollama") {
    // Ollama typically has no API key
  } else {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = cfg.api_key;
  }
  if (cfg.model && !process.env.OPENAI_MODEL && !process.env.MODEL) {
    process.env.OPENAI_MODEL = cfg.model;
  }
  if (cfg.provider_type && !process.env.PROVIDER_TYPE) {
    process.env.PROVIDER_TYPE = cfg.provider_type;
  }
}
