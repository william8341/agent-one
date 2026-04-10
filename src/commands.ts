/**
 * Slash commands — /help, /clear, /model, /compact, /cost, /exit
 */
import type { SlashCommand, CommandContext, ProviderConfig } from "./types.js";
import { PROVIDER_PRESETS, customModelToProvider } from "./llm.js";

export function createBuiltinCommands(): SlashCommand[] {
  return [
    {
      name: "help",
      description: "Show available commands",
      async execute(_args, ctx) {
        const commands = createBuiltinCommands();
        const lines = commands.map((c) => `  /${c.name.padEnd(12)} ${c.description}`);
        return ["", "Available commands:", ...lines, ""].join("\n");
      },
    },
    {
      name: "clear",
      description: "Clear conversation history",
      async execute(_args, ctx) {
        ctx.setState((s) => ({
          ...s,
          messages: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }));
        return null; // signal to clear screen
      },
    },
    {
      name: "model",
      description: "Switch model (e.g., /model <id>)",
      async execute(args, ctx) {
        const modelKey = args.trim();
        const current = ctx.getState().provider;
        const customModels = ctx.customModels;

        // No argument — list all available models
        if (!modelKey) {
          const lines: string[] = [
            `Current: ${current.model} (${current.type})`,
            "",
          ];

          // Custom models from custom-models.json
          if (customModels.length > 0) {
            lines.push("Custom models (custom-models.json):");
            for (const m of customModels) {
              const marker = m.value === current.model ? " ◀" : "";
              lines.push(`  ${m.id.padEnd(36)} ${m.label}${marker}`);
            }
            lines.push("");
          }

          // Built-in presets
          const presets = Object.keys(PROVIDER_PRESETS);
          lines.push("Built-in presets:");
          for (const k of presets) {
            const p = PROVIDER_PRESETS[k]!;
            const marker = p.model === current.model ? " ◀" : "";
            lines.push(`  ${k.padEnd(36)} ${p.type}${marker}`);
          }

          lines.push("");
          lines.push("Usage: /model <id>");
          return lines.join("\n");
        }

        // 1. Match against custom-models.json by id (exact or case-insensitive)
        const customMatch = customModels.find(
          (m) => m.id === modelKey || m.id.toLowerCase() === modelKey.toLowerCase(),
        );
        if (customMatch) {
          const provider = customModelToProvider(customMatch);
          ctx.setState((s) => ({ ...s, provider }));
          return `Switched to ${customMatch.label} (${customMatch.provider})\n  model: ${customMatch.value}\n  base:  ${provider.baseUrl}`;
        }

        // 2. Match against built-in presets
        const preset = PROVIDER_PRESETS[modelKey];
        if (preset) {
          ctx.setState((s) => ({
            ...s,
            provider: { ...preset, apiKey: s.provider.apiKey } as ProviderConfig,
          }));
          return `Switched to ${preset.model} (${preset.type})`;
        }

        // 3. Fuzzy search custom models (substring match on id/label/value)
        const query = modelKey.toLowerCase();
        const fuzzy = customModels.filter(
          (m) =>
            m.id.toLowerCase().includes(query) ||
            m.label.toLowerCase().includes(query) ||
            m.value.toLowerCase().includes(query),
        );
        if (fuzzy.length === 1) {
          const match = fuzzy[0]!;
          const provider = customModelToProvider(match);
          ctx.setState((s) => ({ ...s, provider }));
          return `Switched to ${match.label} (${match.provider})\n  model: ${match.value}\n  base:  ${provider.baseUrl}`;
        }
        if (fuzzy.length > 1) {
          const suggestions = fuzzy.map((m) => `  ${m.id.padEnd(36)} ${m.label}`);
          return [`Multiple matches for "${modelKey}":`, ...suggestions, "", "Use the full id to switch."].join("\n");
        }

        return `Unknown model: ${modelKey}. Use /model to see available models.`;
      },
    },
    {
      name: "cost",
      description: "Show token usage for current session",
      async execute(_args, ctx) {
        const { usage } = ctx.getState();
        return [
          "Session Usage:",
          `  Prompt tokens:     ${usage.promptTokens.toLocaleString()}`,
          `  Completion tokens: ${usage.completionTokens.toLocaleString()}`,
          `  Total tokens:      ${usage.totalTokens.toLocaleString()}`,
        ].join("\n");
      },
    },
    {
      name: "compact",
      description: "Compact conversation context (keep last N messages)",
      async execute(args, ctx) {
        const keep = parseInt(args) || 6;
        ctx.setState((s) => {
          const msgs = s.messages;
          if (msgs.length <= keep) return s;
          return { ...s, messages: msgs.slice(-keep) };
        });
        return `Compacted to last ${keep} messages.`;
      },
    },
    {
      name: "exit",
      description: "Exit the agent",
      async execute() {
        process.exit(0);
      },
    },
  ];
}

// ─── Command parser ──────────────────────────────────────────────────────
export function parseSlashCommand(
  input: string,
): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}
