#!/usr/bin/env node
/**
 * Entry point — AgentOne enterprise AI agent.
 *
 * Supports two modes:
 *  1. Interactive TUI (default) — React + Ink terminal UI
 *  2. Non-interactive (-p/--print) — single-prompt mode, stdout output
 *
 * Environment variables:
 *   OPENAI_API_KEY       — API key for OpenAI-compatible providers
 *   ANTHROPIC_API_KEY    — API key for Anthropic
 *   OPENAI_BASE_URL      — Custom base URL
 *   OPENAI_MODEL         — Model name (default: gpt-4.1-mini)
 *   PROVIDER_TYPE        — "openai" | "anthropic" | "ollama" (default: openai)
 */
import "dotenv/config";
import process from "node:process";
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { Agent } from "./agent.js";
import { LlmClient, PROVIDER_PRESETS, loadCustomModels, customModelToProvider } from "./llm.js";
import { ToolRegistry, registerBuiltinTools } from "./tools.js";
import { loadSkills } from "./skills.js";
import type { ProviderConfig, ProviderType, CustomModelEntry } from "./types.js";

// ─── Resolve provider config from environment ───────────────────────────
function resolveProvider(): ProviderConfig {
  const modelEnv = process.env.OPENAI_MODEL ?? process.env.MODEL;
  const typeEnv = (process.env.PROVIDER_TYPE ?? "openai") as ProviderType;

  // Check if a preset is specified
  if (modelEnv && PROVIDER_PRESETS[modelEnv]) {
    const preset = PROVIDER_PRESETS[modelEnv];
    return {
      ...preset,
      apiKey:
        preset.type === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY,
    } as ProviderConfig;
  }

  // Determine API key
  let apiKey: string | undefined;
  if (typeEnv === "anthropic") {
    apiKey = process.env.ANTHROPIC_API_KEY;
  } else if (typeEnv !== "ollama") {
    apiKey = process.env.OPENAI_API_KEY;
  }

  // Build config
  const baseUrl =
    process.env.OPENAI_BASE_URL ??
    (typeEnv === "anthropic"
      ? "https://api.anthropic.com"
      : typeEnv === "ollama"
        ? "http://localhost:11434/v1"
        : "https://api.openai.com/v1");

  const model = modelEnv ?? (typeEnv === "anthropic" ? "claude-sonnet-4-6-20250414" : "gpt-4.1-mini");

  return { type: typeEnv, apiKey, baseUrl, model };
}

// ─── Parse CLI arguments ─────────────────────────────────────────────────
function parseArgs(): { printMode: boolean; prompt: string; model?: string } {
  const args = process.argv.slice(2);
  let printMode = false;
  let model: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p" || arg === "--print") {
      printMode = true;
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
AgentOne — Enterprise AI Agent

Usage:
  agent-one [options] [prompt]

Options:
  -p, --print           Non-interactive mode (single prompt, stdout output)
  --model <name>        Model preset or custom model name
  -h, --help            Show this help

Environment:
  OPENAI_API_KEY        API key for OpenAI-compatible providers
  ANTHROPIC_API_KEY     API key for Anthropic
  OPENAI_BASE_URL       Custom API base URL
  OPENAI_MODEL          Model name (default: gpt-4.1-mini)
  PROVIDER_TYPE         "openai" | "anthropic" | "ollama"

Examples:
  agent-one                              # Interactive TUI
  agent-one -p "list files in src/"      # Non-interactive
  agent-one --model claude-sonnet-4-6    # Use Claude Sonnet
  agent-one --model ollama/llama3        # Use local Ollama
`);
      process.exit(0);
    } else {
      rest.push(arg);
    }
  }

  return { printMode, prompt: rest.join(" ").trim(), model };
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const { printMode, prompt, model } = parseArgs();
  const cwd = process.cwd();

  // Load custom models and skills in parallel
  const [customModels, skills] = await Promise.all([
    loadCustomModels(cwd),
    loadSkills(cwd),
  ]);

  // Resolve provider: --model flag > env vars > custom-models.json first entry
  let provider: ProviderConfig;

  if (model) {
    // Explicit --model flag
    const customMatch = customModels.find(
      (m) => m.id === model || m.id.toLowerCase() === model!.toLowerCase(),
    );
    if (customMatch) {
      provider = customModelToProvider(customMatch);
    } else {
      const preset = PROVIDER_PRESETS[model];
      const envProvider = resolveProvider();
      if (preset) {
        provider = { ...preset, apiKey: envProvider.apiKey } as ProviderConfig;
      } else {
        provider = { ...envProvider, model };
      }
    }
  } else if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_MODEL || process.env.PROVIDER_TYPE) {
    // Env vars explicitly set — use them
    provider = resolveProvider();
  } else if (customModels.length > 0) {
    // No env vars, no --model — default to first entry in custom-models.json
    provider = customModelToProvider(customModels[0]!);
  } else {
    provider = resolveProvider();
  }

  // Validate API key (not needed for ollama/openrouter-with-key)
  if (provider.type !== "ollama" && !provider.apiKey) {
    const keyName = provider.type === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    console.error(`Error: Missing ${keyName}. Set it in .env or environment.`);
    console.error(`Tip: Or configure models in custom-models.json`);
    process.exit(1);
  }

  // ─── Non-interactive (print) mode ──────────────────────────────────
  if (printMode || (prompt && !process.stdin.isTTY)) {
    if (!prompt) {
      console.error("Error: No prompt provided. Usage: agent-one -p 'your prompt'");
      process.exit(1);
    }
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const llm = new LlmClient(provider);
    const agent = new Agent(llm, registry, skills, { cwd });
    const result = await agent.run(prompt);
    process.stdout.write(result + "\n");
    return;
  }

  // ─── Interactive TUI mode ─────────────────────────────────────────
  const { waitUntilExit } = render(
    React.createElement(App, { provider, skills, cwd, customModels }),
    {
      exitOnCtrlC: true,
    },
  );

  await waitUntilExit();
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
