/**
 * Slash command registry — commands categorized by type following claude-src design.
 *
 *  local   — executes locally, does NOT enter agent loop.
 *  prompt  — expands to a prompt string sent to the agent loop.
 *
 * Execution flow in App.tsx:
 *  1. parseSlashCommand(input)
 *  2. findCommand(name, commands)
 *  3. switch(command.type):
 *       local  → command.execute(args, ctx) → display result
 *       prompt → command.getPrompt(args, ctx) → feed into agent.runStreaming()
 */
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Command,
  LocalCommand,
  PromptCommand,
  CommandContext,
  ProviderConfig,
  LocalCommandResult,
} from "./types.js";
import { PROVIDER_PRESETS, customModelToProvider } from "./llm.js";

// ═══════════════════════════════════════════════════════════════════════════
//  LOCAL commands — execute locally, never enter agent loop
// ═══════════════════════════════════════════════════════════════════════════

const helpCommand: LocalCommand = {
  type: "local",
  name: "help",
  description: "Show available commands",
  async execute(_args, ctx) {
    const cmds = createBuiltinCommands();
    // Group by type
    const locals = cmds.filter((c) => c.type === "local" && !c.isHidden);
    const prompts = cmds.filter((c) => c.type === "prompt" && !c.isHidden);

    const lines: string[] = [""];

    if (locals.length > 0) {
      lines.push("Local commands (run locally, no agent):");
      for (const c of locals) {
        const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
        const aliases = c.aliases?.length ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : "";
        lines.push(`  /${c.name}${hint}${" ".repeat(Math.max(1, 22 - c.name.length - hint.length))}${c.description}${aliases}`);
      }
      lines.push("");
    }

    if (prompts.length > 0) {
      lines.push("Prompt commands (sent to agent):");
      for (const c of prompts) {
        const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
        lines.push(`  /${c.name}${hint}${" ".repeat(Math.max(1, 22 - c.name.length - hint.length))}${c.description}`);
      }
      lines.push("");
    }

    return { type: "text", value: lines.join("\n") };
  },
};

const clearCommand: LocalCommand = {
  type: "local",
  name: "clear",
  aliases: ["cls"],
  description: "Clear conversation history",
  async execute() {
    return { type: "clear" };
  },
};

const modelCommand: LocalCommand = {
  type: "local",
  name: "model",
  description: "Switch model",
  argumentHint: "[id]",
  async execute(args, ctx) {
    const modelKey = args.trim();
    const current = ctx.getState().provider;
    const customModels = ctx.customModels;

    if (!modelKey) {
      const lines: string[] = [
        `Current: ${current.model} (${current.type})`,
        "",
      ];
      if (customModels.length > 0) {
        lines.push("Custom models (custom-models.json):");
        for (const m of customModels) {
          const marker = m.value === current.model ? " ◀" : "";
          lines.push(`  ${m.id.padEnd(36)} ${m.label}${marker}`);
        }
        lines.push("");
      }
      const presets = Object.keys(PROVIDER_PRESETS);
      lines.push("Built-in presets:");
      for (const k of presets) {
        const p = PROVIDER_PRESETS[k]!;
        const marker = p.model === current.model ? " ◀" : "";
        lines.push(`  ${k.padEnd(36)} ${p.type}${marker}`);
      }
      lines.push("", "Usage: /model <id>");
      return { type: "text", value: lines.join("\n") };
    }

    // 1. custom-models.json match
    const customMatch = customModels.find(
      (m) => m.id === modelKey || m.id.toLowerCase() === modelKey.toLowerCase(),
    );
    if (customMatch) {
      const provider = customModelToProvider(customMatch);
      ctx.setState((s) => ({ ...s, provider }));
      return {
        type: "text",
        value: `Switched to ${customMatch.label} (${customMatch.provider})\n  model: ${customMatch.value}\n  base:  ${provider.baseUrl}`,
      };
    }

    // 2. built-in preset
    const preset = PROVIDER_PRESETS[modelKey];
    if (preset) {
      ctx.setState((s) => ({
        ...s,
        provider: { ...preset, apiKey: s.provider.apiKey } as ProviderConfig,
      }));
      return { type: "text", value: `Switched to ${preset.model} (${preset.type})` };
    }

    // 3. fuzzy
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
      return {
        type: "text",
        value: `Switched to ${match.label} (${match.provider})\n  model: ${match.value}\n  base:  ${provider.baseUrl}`,
      };
    }
    if (fuzzy.length > 1) {
      const suggestions = fuzzy.map((m) => `  ${m.id.padEnd(36)} ${m.label}`);
      return {
        type: "text",
        value: [`Multiple matches for "${modelKey}":`, ...suggestions, "", "Use the full id."].join("\n"),
      };
    }

    return { type: "text", value: `Unknown model: ${modelKey}. Use /model to list.` };
  },
};

const costCommand: LocalCommand = {
  type: "local",
  name: "cost",
  aliases: ["usage"],
  description: "Show token usage for current session",
  async execute(_args, ctx) {
    const { usage } = ctx.getState();
    return {
      type: "text",
      value: [
        "Session Usage:",
        `  Prompt tokens:     ${usage.promptTokens.toLocaleString()}`,
        `  Completion tokens: ${usage.completionTokens.toLocaleString()}`,
        `  Total tokens:      ${usage.totalTokens.toLocaleString()}`,
      ].join("\n"),
    };
  },
};

const compactCommand: LocalCommand = {
  type: "local",
  name: "compact",
  description: "Compact conversation (keep last N messages)",
  argumentHint: "[N]",
  async execute(args, ctx) {
    const keep = parseInt(args) || 6;
    ctx.setState((s) => {
      if (s.messages.length <= keep) return s;
      return { ...s, messages: s.messages.slice(-keep) };
    });
    return { type: "text", value: `Compacted to last ${keep} messages.` };
  },
};

const statusCommand: LocalCommand = {
  type: "local",
  name: "status",
  description: "Show project and session status",
  async execute(_args, ctx) {
    const state = ctx.getState();
    let gitBranch = "N/A";
    try {
      gitBranch = execSync("git branch --show-current", { cwd: ctx.cwd, timeout: 3000 })
        .toString()
        .trim();
    } catch { /* not a git repo */ }

    let gitStatus = "";
    try {
      gitStatus = execSync("git status --short", { cwd: ctx.cwd, timeout: 3000 })
        .toString()
        .trim();
    } catch { /* ignore */ }

    const lines = [
      "Session Status:",
      `  Model:      ${state.provider.model} (${state.provider.type})`,
      `  Status:     ${state.status}`,
      `  Messages:   ${state.messages.length}`,
      `  Tokens:     ${state.usage.totalTokens.toLocaleString()}`,
      `  CWD:        ${ctx.cwd}`,
      `  Git branch: ${gitBranch}`,
    ];
    if (gitStatus) {
      lines.push("", "Git changes:", ...gitStatus.split("\n").map((l) => `  ${l}`));
    }
    return { type: "text", value: lines.join("\n") };
  },
};

const skillsCommand: LocalCommand = {
  type: "local",
  name: "skills",
  description: "List loaded skills",
  async execute(_args, ctx) {
    if (ctx.skills.length === 0) {
      return { type: "text", value: "No skills loaded.\nAdd .md files to skills/ directory." };
    }
    const lines = ["Loaded skills:", ""];
    for (const s of ctx.skills) {
      lines.push(`  ${s.name.padEnd(24)} ${s.description}`);
      if (s.whenToUse) lines.push(`  ${"".padEnd(24)} when: ${s.whenToUse}`);
      if (s.allowedTools) lines.push(`  ${"".padEnd(24)} tools: ${s.allowedTools.join(", ")}`);
    }
    return { type: "text", value: lines.join("\n") };
  },
};

const configCommand: LocalCommand = {
  type: "local",
  name: "config",
  description: "Show current configuration",
  async execute(_args, ctx) {
    const state = ctx.getState();
    const lines = [
      "Configuration:",
      `  Provider:     ${state.provider.type}`,
      `  Model:        ${state.provider.model}`,
      `  Base URL:     ${state.provider.baseUrl}`,
      `  API Key:      ${state.provider.apiKey ? "***" + state.provider.apiKey.slice(-4) : "(none)"}`,
      `  Max tokens:   ${state.provider.maxTokens ?? "default"}`,
      `  Temperature:  ${state.provider.temperature ?? "0.2"}`,
      `  CWD:          ${ctx.cwd}`,
      `  Custom models: ${ctx.customModels.length}`,
      `  Skills:       ${ctx.skills.length}`,
    ];
    return { type: "text", value: lines.join("\n") };
  },
};

const exitCommand: LocalCommand = {
  type: "local",
  name: "exit",
  aliases: ["quit", "q"],
  description: "Exit the agent",
  async execute() {
    process.exit(0);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PROMPT commands — expand to a prompt sent to the agent loop
// ═══════════════════════════════════════════════════════════════════════════

const commitCommand: PromptCommand = {
  type: "prompt",
  name: "commit",
  description: "Stage and commit changes with AI-generated message",
  async getPrompt(args) {
    const extra = args ? `\nAdditional instructions: ${args}` : "";
    return [
      "Please help me commit my current changes. Follow these steps:",
      "1. Run `git status` to see all changes",
      "2. Run `git diff` to understand what changed",
      "3. Run `git log --oneline -5` to see commit message style",
      "4. Stage relevant files (avoid .env, credentials, large binaries)",
      "5. Create a concise commit message in imperative mood",
      "6. Execute the commit",
      "Never amend or force push without asking.",
      extra,
    ].join("\n");
  },
};

const reviewCommand: PromptCommand = {
  type: "prompt",
  name: "review",
  description: "Code review for specified files or recent changes",
  argumentHint: "[file|path]",
  async getPrompt(args) {
    const target = args || "the recently changed files (use git diff)";
    return [
      `Please review ${target}. Analyze for:`,
      "1. Correctness — logic errors, edge cases",
      "2. Security — injection, unsafe input, exposed secrets",
      "3. Performance — unnecessary allocations, blocking operations",
      "4. Maintainability — naming, complexity, DRY",
      "5. Best practices — language idioms, framework conventions",
      "",
      "Format: Summary → Critical issues → Suggestions → Positives",
    ].join("\n");
  },
};

const fixCommand: PromptCommand = {
  type: "prompt",
  name: "fix",
  description: "Fix a bug or error",
  argumentHint: "<description>",
  async getPrompt(args) {
    if (!args) return "What would you like me to fix? Please describe the issue.";
    return [
      `Please fix the following issue: ${args}`,
      "",
      "Steps:",
      "1. Read relevant files to understand the context",
      "2. Identify the root cause",
      "3. Apply the minimal fix",
      "4. Verify the fix works",
    ].join("\n");
  },
};

const testCommand: PromptCommand = {
  type: "prompt",
  name: "test",
  description: "Run tests or write tests for code",
  argumentHint: "[file|description]",
  async getPrompt(args) {
    if (!args) {
      return "Please run the project's test suite and report the results. If tests fail, analyze and fix them.";
    }
    return `Please write or run tests for: ${args}\n\nIf tests already exist, run them. If not, create appropriate tests.`;
  },
};

const explainCommand: PromptCommand = {
  type: "prompt",
  name: "explain",
  description: "Explain code or a concept",
  argumentHint: "<file|concept>",
  async getPrompt(args) {
    if (!args) return "What would you like me to explain?";
    return `Please explain: ${args}\n\nRead the relevant code first, then provide a clear, structured explanation.`;
  },
};

const refactorCommand: PromptCommand = {
  type: "prompt",
  name: "refactor",
  description: "Refactor code for better quality",
  argumentHint: "<file|description>",
  async getPrompt(args) {
    if (!args) return "What would you like me to refactor?";
    return [
      `Please refactor: ${args}`,
      "",
      "Focus on:",
      "- Reducing complexity",
      "- Improving readability",
      "- Removing duplication",
      "- Following language best practices",
      "",
      "Make minimal changes. Don't change behavior.",
    ].join("\n");
  },
};

const searchCommand: PromptCommand = {
  type: "prompt",
  name: "search",
  aliases: ["find", "grep"],
  description: "Search the codebase",
  argumentHint: "<query>",
  async getPrompt(args) {
    if (!args) return "What would you like me to search for?";
    return `Search the codebase for: ${args}\n\nUse glob_files and search tools to find relevant files and code. Report findings clearly.`;
  },
};

const buildCommand: PromptCommand = {
  type: "prompt",
  name: "build",
  description: "Build the project and fix errors",
  async getPrompt(args) {
    const extra = args ? `\nBuild command hint: ${args}` : "";
    return `Please build the project. Detect the build system (package.json scripts, Makefile, etc.), run the build, and fix any errors.${extra}`;
  },
};

const prCommand: PromptCommand = {
  type: "prompt",
  name: "pr",
  description: "Create a pull request with AI-generated description",
  argumentHint: "[base-branch]",
  async getPrompt(args) {
    const base = args || "main";
    return [
      `Create a pull request targeting '${base}'. Steps:`,
      "1. Run git status and git log to understand changes",
      `2. Run git diff ${base}...HEAD to see all changes`,
      "3. Draft a concise PR title (under 72 chars)",
      "4. Write a description with Summary and Test plan sections",
      "5. Push the branch and create the PR using gh cli",
    ].join("\n");
  },
};

const docsCommand: PromptCommand = {
  type: "prompt",
  name: "docs",
  description: "Generate or update documentation",
  argumentHint: "[file|topic]",
  async getPrompt(args) {
    if (!args) return "Please review the project and suggest what documentation is missing or outdated.";
    return `Please generate or update documentation for: ${args}`;
  },
};

const shellCommand: PromptCommand = {
  type: "prompt",
  name: "sh",
  aliases: ["shell", "bash"],
  description: "Execute a shell command via agent",
  argumentHint: "<command>",
  async getPrompt(args) {
    if (!args) return "What shell command would you like me to run?";
    return `Please run this shell command and explain the output: ${args}`;
  },
};

const planCommand: PromptCommand = {
  type: "prompt",
  name: "plan",
  description: "Create an implementation plan",
  argumentHint: "<task>",
  async getPrompt(args) {
    if (!args) return "What would you like me to plan?";
    return [
      `Create a detailed implementation plan for: ${args}`,
      "",
      "Include:",
      "1. Analysis of current codebase (read relevant files first)",
      "2. Step-by-step implementation approach",
      "3. Files to create or modify",
      "4. Potential risks or trade-offs",
      "",
      "Do NOT implement anything — only plan.",
    ].join("\n");
  },
};

const summaryCommand: PromptCommand = {
  type: "prompt",
  name: "summary",
  description: "Summarize recent changes or a file",
  argumentHint: "[file|git]",
  async getPrompt(args) {
    if (!args || args === "git") {
      return "Summarize the recent git changes. Run git log --oneline -20 and git diff, then give a concise summary.";
    }
    return `Please read and summarize: ${args}`;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Registry
// ═══════════════════════════════════════════════════════════════════════════

export function createBuiltinCommands(): Command[] {
  return [
    // ── local commands ──
    helpCommand,
    clearCommand,
    modelCommand,
    costCommand,
    compactCommand,
    statusCommand,
    skillsCommand,
    configCommand,
    exitCommand,
    // ── prompt commands ──
    commitCommand,
    reviewCommand,
    fixCommand,
    testCommand,
    explainCommand,
    refactorCommand,
    searchCommand,
    buildCommand,
    prCommand,
    docsCommand,
    shellCommand,
    planCommand,
    summaryCommand,
  ];
}

// ─── Command lookup (supports aliases) ───────────────────────────────────
export function findCommand(name: string, commands: Command[]): Command | undefined {
  const lower = name.toLowerCase();
  return commands.find(
    (c) => c.name === lower || c.aliases?.includes(lower),
  );
}

// ─── Command parser ──────────────────────────────────────────────────────
export function parseSlashCommand(
  input: string,
): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}
