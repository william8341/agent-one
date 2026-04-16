#!/usr/bin/env node
/**
 * AgentOne — enterprise AI agent CLI.
 *
 * Claude Code integration: subcommands run | version | setup-check | login | status | result | cancel
 * Legacy: -p / --print, interactive TUI when no subcommand and stdin is TTY.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readlinePromises from "node:readline/promises";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { Agent } from "./agent.js";
import {
  LlmClient,
  PROVIDER_PRESETS,
  loadCustomModels,
  customModelToProvider,
  hasEffectiveCloudApiKeys,
  effectiveOpenAiApiKeyFromEnv,
  effectiveAnthropicApiKeyFromEnv,
  isPlaceholderApiKeyValue,
} from "./llm.js";
import { ToolRegistry, registerBuiltinTools } from "./tools.js";
import { loadSkills } from "./skills.js";
import {
  loadAgentOneConfig,
  applyConfigToEnv,
  saveApiKeyToConfig,
  AGENT_ONE_CONFIG_PATH,
} from "./agent-one-config.js";
import { runAgentTask } from "./run-task.js";
import type { ProviderConfig, ProviderType, CustomModelEntry } from "./types.js";
import {
  writeJob,
  readJob,
  updateJob,
  spawnBackgroundRun,
  latestJobFile,
  type JobRecord,
} from "./jobs.js";
import { startHttpService } from "./http-service.js";
import {
  executeTeamPlan,
  formatRunSummary,
  generateTeamPlan,
  initTeamMvp,
  parseTeamExecuteArgs,
  parseTeamInitArgs,
  parseTeamPlanArgs,
  printTeamHelp,
} from "./team-runner.js";

const PKG_VERSION = (
  JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Stderr line proving the real Node CLI ran (not LLM-simulated). Bash captures this with stdout. */
function emitInvocationMarker(payload: Record<string, unknown>): void {
  const line = {
    agent_one_cli: true,
    v: PKG_VERSION,
    pid: process.pid,
    /** Shell directory where the `agent-one` process was started (same as `pwd` at launch). */
    invocation_pwd: process.cwd(),
    ...payload,
  };
  process.stderr.write(`[agent-one-cli] ${JSON.stringify(line)}\n`);
  /** Human-readable path line for logs and copy-paste. */
  const taskCwd = payload.task_cwd;
  if (typeof taskCwd === "string" && taskCwd.length > 0) {
    process.stderr.write(`[agent-one-cli] task_cwd=${taskCwd}\n`);
  }
}

function applyAgentOneApiKeyFromEnv(): void {
  const k = process.env.AGENT_ONE_API_KEY;
  if (!k) return;
  const pt = (process.env.PROVIDER_TYPE ?? "openai") as string;
  if (pt === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = k;
  } else if (pt !== "ollama") {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = k;
  }
}

// ─── Provider resolution (TUI path — keeps original behavior) ───────────
function resolveProvider(): ProviderConfig {
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

  const model = modelEnv ?? (typeEnv === "anthropic" ? "claude-sonnet-4-6-20250414" : "gpt-4.1-mini");

  return { type: typeEnv, apiKey, baseUrl, model };
}

type RunOptions = {
  cwd: string;
  format: "markdown" | "json" | "plain";
  timeout?: number;
  outputFile?: string;
  background: boolean;
  model?: string;
  apiKey?: string;
};

type ServeOptions = {
  host: string;
  port: number;
  token: string;
  cwd: string;
  model?: string;
};

function parseRunArgs(argv: string[]): { task: string; opts: RunOptions } | { error: string } {
  const opts: RunOptions = {
    cwd: process.cwd(),
    format: "markdown",
    background: false,
  };

  let i = 0;
  const parts: string[] = [];

  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      parts.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--cwd" && argv[i + 1]) {
      opts.cwd = argv[++i]!;
      i++;
      continue;
    }
    if (a === "--format" && argv[i + 1]) {
      const f = argv[++i] as RunOptions["format"];
      if (f !== "markdown" && f !== "json" && f !== "plain") {
        return { error: `--format must be markdown, json, or plain` };
      }
      opts.format = f;
      i++;
      continue;
    }
    if (a === "--timeout" && argv[i + 1]) {
      opts.timeout = Number(argv[++i]);
      if (Number.isNaN(opts.timeout) || opts.timeout < 1) {
        return { error: `--timeout must be a positive number` };
      }
      i++;
      continue;
    }
    if (a === "--output-file" && argv[i + 1]) {
      opts.outputFile = argv[++i];
      i++;
      continue;
    }
    if (a === "--background" || a === "-b") {
      opts.background = true;
      i++;
      continue;
    }
    if (a === "--model" && argv[i + 1]) {
      opts.model = argv[++i];
      i++;
      continue;
    }
    if (a === "--api-key" && argv[i + 1]) {
      opts.apiKey = argv[++i];
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return { error: `Unknown option: ${a}` };
    }
    parts.push(a);
    i++;
  }

  const task = parts.join(" ").trim();
  if (!task) {
    return { error: "Missing task text. Usage: agent-one run \"<task>\" [...]" };
  }
  return { task, opts };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}s timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function parseServeArgs(argv: string[]): { opts: ServeOptions } | { error: string } {
  const opts: Partial<ServeOptions> = {
    host: "127.0.0.1",
    port: 8080,
    token: process.env.AGENT_ONE_HTTP_TOKEN,
    cwd: process.cwd(),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--host" && argv[i + 1]) {
      opts.host = argv[++i]!;
      continue;
    }
    if (a === "--port" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { error: "--port must be an integer between 1 and 65535" };
      }
      opts.port = n;
      continue;
    }
    if (a === "--token" && argv[i + 1]) {
      opts.token = argv[++i]!;
      continue;
    }
    if (a === "--cwd" && argv[i + 1]) {
      opts.cwd = argv[++i]!;
      continue;
    }
    if (a === "--model" && argv[i + 1]) {
      opts.model = argv[++i]!;
      continue;
    }
    return { error: `Unknown option: ${a}` };
  }

  if (!opts.token) {
    return { error: "Missing token. Use --token or AGENT_ONE_HTTP_TOKEN." };
  }

  return { opts: opts as ServeOptions };
}

async function cmdRun(parsed: { task: string; opts: RunOptions }, entryScript: string) {
  const { task, opts } = parsed;
  emitInvocationMarker({
    sub: "run",
    task_cwd: opts.cwd,
    background: opts.background,
    format: opts.format,
    task_chars: task.length,
  });
  if (opts.apiKey) {
    if ((process.env.PROVIDER_TYPE ?? "openai") === "anthropic") {
      process.env.ANTHROPIC_API_KEY = opts.apiKey;
    } else {
      process.env.OPENAI_API_KEY = opts.apiKey;
    }
  }

  const cfg = loadAgentOneConfig();
  const timeoutSec = opts.timeout ?? cfg.default_timeout ?? 120;
  if (cfg.output_format && opts.format === "markdown") {
    opts.format = cfg.output_format;
  }

  if (opts.background) {
    const jobId = Math.random().toString(36).slice(2, 10);
    const outPath = opts.outputFile ?? `/tmp/agent-one-${jobId}.md`;
    const job: JobRecord = {
      job_id: jobId,
      status: "running",
      started_at: new Date().toISOString(),
      task,
      cwd: opts.cwd,
      model: opts.model,
      output_file: outPath,
    };
    writeJob(job);
    spawnBackgroundRun(job, entryScript);
    process.stdout.write(`job-id: ${jobId}\n`);
    process.stdout.write(
      `Started background job. Use 'agent-one status ${jobId}' to check progress.\n`,
    );
    return;
  }

  try {
    const result = await withTimeout(
      runAgentTask(task, opts.cwd, opts.model),
      timeoutSec * 1000,
      "Task",
    );

    let out = result;
    if (opts.format === "json") {
      out = JSON.stringify({ status: "success", result }, null, 0);
    } else if (opts.format === "plain") {
      out = result.replace(/\*\*|`|#/g, "");
    }

    if (opts.outputFile) {
      fs.writeFileSync(opts.outputFile, out + (out.endsWith("\n") ? "" : "\n"), "utf8");
      process.stdout.write(`Result written to ${opts.outputFile}\n`);
    } else {
      process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
    }
  } catch (e) {
    console.error(`Error: ${String(e)}`);
    process.exit(1);
  }
}

async function cmdServe(parsed: { opts: ServeOptions }, entryScript: string) {
  const { opts } = parsed;
  emitInvocationMarker({
    sub: "serve",
    host: opts.host,
    port: opts.port,
    task_cwd: opts.cwd,
    model: opts.model,
  });
  await startHttpService({
    host: opts.host,
    port: opts.port,
    token: opts.token,
    cwd: opts.cwd,
    model: opts.model,
    entryScript,
  });
}

async function cmdTeam(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(printTeamHelp());
    return;
  }

  if (sub === "init") {
    const parsed = parseTeamInitArgs(argv.slice(1));
    if ("error" in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    emitInvocationMarker({ sub: "team.init", task_cwd: parsed.opts.cwd, force: parsed.opts.force });
    const out = await initTeamMvp(parsed.opts);
    process.stdout.write(`${out}\n`);
    return;
  }

  if (sub === "execute") {
    const parsed = parseTeamExecuteArgs(argv.slice(1));
    if ("error" in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    emitInvocationMarker({
      sub: "team.execute",
      task_cwd: parsed.opts.cwd,
      team_file: parsed.opts.teamPath,
      plan_file: parsed.opts.planPath,
      verbose: parsed.opts.verbose,
    });
    try {
      const summary = await executeTeamPlan(parsed.opts);
      process.stdout.write(`${formatRunSummary(summary)}\n`);
      if (summary.status !== "success") {
        process.exit(1);
      }
      return;
    } catch (error) {
      console.error(`Error: ${String(error)}`);
      process.exit(1);
    }
  }

  if (sub === "plan") {
    const parsed = parseTeamPlanArgs(argv.slice(1));
    if ("error" in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    emitInvocationMarker({
      sub: "team.plan",
      task_cwd: parsed.opts.cwd,
      team_file: parsed.opts.teamPath,
      output_file: parsed.opts.outputPath,
      model: parsed.opts.model,
    });
    try {
      const out = await generateTeamPlan(parsed.opts);
      process.stdout.write(
        [
          `Plan written to: ${out.planPath}`,
          `Goal: ${out.goal}`,
          `Model: ${out.model ?? "(default)"}`,
          "Output format: strict JSON plan",
        ].join("\n") + "\n",
      );
      return;
    } catch (error) {
      console.error(`Error: ${String(error)}`);
      process.exit(1);
    }
  }

  console.error(`Unknown team subcommand: ${sub}`);
  process.stdout.write(printTeamHelp());
  process.exit(1);
}

async function cmdBackgroundWorker(jobPath: string) {
  let job: JobRecord;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, "utf8")) as JobRecord;
  } catch {
    console.error("Error: invalid job file");
    process.exit(1);
    return;
  }

  emitInvocationMarker({
    sub: "_background-worker",
    job_id: job.job_id,
    task_cwd: job.cwd,
  });

  try {
    const result = await runAgentTask(job.task, job.cwd, job.model);
    fs.writeFileSync(job.output_file, result + "\n", "utf8");
    updateJob(job.job_id, { status: "completed", progress: 100 });
  } catch (e) {
    const msg = String(e);
    updateJob(job.job_id, { status: "failed", error: msg });
    try {
      fs.writeFileSync(job.output_file, `Error: ${msg}\n`, "utf8");
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

function hasCustomModelsInCwd(): boolean {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "custom-models.json"), "utf8");
    const data = JSON.parse(raw) as { models?: unknown[] };
    return Array.isArray(data.models) && data.models.length > 0;
  } catch {
    return false;
  }
}

function cmdSetupCheck() {
  emitInvocationMarker({ sub: "setup-check" });
  const issues: string[] = [];
  const cfg = loadAgentOneConfig();
  applyConfigToEnv(cfg);

  const hasEnvKey =
    (process.env.AGENT_ONE_API_KEY && !isPlaceholderApiKeyValue(process.env.AGENT_ONE_API_KEY)) ||
    hasEffectiveCloudApiKeys() ||
    (cfg.api_key && !isPlaceholderApiKeyValue(cfg.api_key));

  const hasCustomModels = hasCustomModelsInCwd();

  if (hasEnvKey) {
    const preview = (
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.AGENT_ONE_API_KEY ||
      cfg.api_key ||
      ""
    ).slice(0, 8);
    process.stdout.write(`✓ API key configured (${preview}...)\n`);
  } else if (hasCustomModels) {
    process.stdout.write(
      "✓ custom-models.json found in cwd (LLM from file; per-model apiKey optional)\n",
    );
  } else {
    issues.push(
      "✗ No API key and no custom-models.json. Set AGENT_ONE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY, run: agent-one login, or add custom-models.json in the project directory.",
    );
  }

  if (issues.length) {
    for (const line of issues) {
      console.error(line);
    }
    process.exit(1);
  }
  process.stdout.write("✓ agent-one is ready to use with Claude Code\n");
}

async function cmdLoginAsync(apiKey?: string, provider: "openai" | "anthropic" = "openai") {
  emitInvocationMarker({ sub: "login", provider, non_interactive: Boolean(apiKey) });
  if (apiKey) {
    saveApiKeyToConfig(apiKey, provider);
    process.stdout.write(`✓ API key saved to ${AGENT_ONE_CONFIG_PATH}\n`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("Error: TTY required for interactive login, or pass --api-key");
    process.exit(1);
  }
  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const key = await rl.question("Enter API key: ");
    const trimmed = key.trim();
    if (!trimmed) {
      console.error("Error: empty API key");
      process.exit(1);
    }
    saveApiKeyToConfig(trimmed, provider);
    process.stdout.write("✓ Logged in successfully\n");
  } finally {
    await rl.close();
  }
}

function cmdStatus(jobId?: string) {
  emitInvocationMarker({ sub: "status", job_id: jobId ?? "latest" });
  let path: string | null = null;
  if (jobId) {
    const j = readJob(jobId);
    if (!j) {
      console.error(`Job not found: ${jobId}`);
      process.exit(1);
    }
    printJobSummary(j);
    return;
  }
  path = latestJobFile();
  if (!path) {
    process.stdout.write("No jobs found.\n");
    return;
  }
  const j = JSON.parse(fs.readFileSync(path, "utf8")) as JobRecord;
  printJobSummary(j);
}

function printJobSummary(job: JobRecord) {
  process.stdout.write(`Job ID:  ${job.job_id}\n`);
  process.stdout.write(`Status:  ${job.status}\n`);
  if (job.progress != null) process.stdout.write(`Progress: ${job.progress}% complete\n`);
  process.stdout.write(`Started: ${job.started_at}\n`);
  process.stdout.write(`Task:    ${job.task}\n`);
  if (job.error) process.stdout.write(`Error:   ${job.error}\n`);
}

function cmdResult(jobId?: string) {
  emitInvocationMarker({ sub: "result", job_id: jobId ?? "latest" });
  let job: JobRecord | null = null;
  if (jobId) {
    job = readJob(jobId);
    if (!job) {
      console.error(`Job not found: ${jobId}`);
      process.exit(1);
    }
  } else {
    const p = latestJobFile();
    if (p) job = JSON.parse(fs.readFileSync(p, "utf8")) as JobRecord;
  }
  if (!job) {
    process.stdout.write("No jobs found.\n");
    return;
  }
  if (job.status !== "completed") {
    process.stdout.write(`Job ${job.job_id} is not yet complete (status: ${job.status})\n`);
    process.exit(1);
  }
  const op = job.output_file;
  if (!fs.existsSync(op)) {
    console.error("Result file not found.");
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(op, "utf8"));
}

function cmdCancel(jobId: string) {
  emitInvocationMarker({ sub: "cancel", job_id: jobId });
  const job = readJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }
  const pid = job.pid;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      process.stdout.write(`Cancelled job ${jobId}\n`);
    } catch {
      process.stdout.write(`Job ${jobId} already finished.\n`);
    }
  }
  updateJob(jobId, { status: "cancelled" });
}

// ─── Legacy parse (TUI / -p) ────────────────────────────────────────────
function parseLegacyArgs(): { printMode: boolean; prompt: string; model?: string } {
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
      printGlobalHelp();
      process.exit(0);
    } else {
      rest.push(arg);
    }
  }

  return { printMode, prompt: rest.join(" ").trim(), model };
}

function printGlobalHelp() {
  process.stdout.write(`
AgentOne — Enterprise AI Agent

Usage:
  agent-one <command> [options]
  agent-one [options] [prompt]           # Interactive TUI (default)

Commands (Claude Code):
  run <task>       Run agent on a task (use --cwd, --format, --timeout, --output-file, --background)
  team             Team MVP helpers (init / execute)
  serve            Start HTTP API service (/api/external/agent-executions)
  version          Show version
  setup-check      Verify environment for Claude Code
  login            Save API key to ~/.agent-one/config.toml
  status [job-id]  Background job status
  result [job-id]  Background job output
  cancel <job-id>  Cancel background job

Options (legacy / TUI):
  -p, --print           Non-interactive (same as: agent-one run "<prompt>")
  --model <name>        Model preset or custom model name
  -h, --help            Show this help

Examples:
  agent-one run "list files in src/" --cwd "$PWD" --format markdown
  agent-one team init
  agent-one team plan --goal "review code and run tests"
  agent-one team execute --plan team/example.plan.json
  agent-one serve --host 0.0.0.0 --port 8080 --token xxx
  agent-one version
  agent-one setup-check
  agent-one login --api-key sk-...

Environment:
  AGENT_ONE_API_KEY     Generic API key (maps by PROVIDER_TYPE)
  OPENAI_API_KEY        OpenAI-compatible providers
  ANTHROPIC_API_KEY     Anthropic
  OPENAI_BASE_URL       Custom API base URL
  OPENAI_MODEL / MODEL  Model name
  PROVIDER_TYPE         openai | anthropic | ollama
  AGENT_ONE_HTTP_TOKEN  HTTP service bearer token
`);
}

async function runTuiMode() {
  const { printMode, prompt, model } = parseLegacyArgs();
  const cwd = process.cwd();

  const [customModels, skills] = await Promise.all([loadCustomModels(cwd), loadSkills(cwd)]);

  let provider: ProviderConfig;

  if (model) {
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
  } else if (hasEffectiveCloudApiKeys()) {
    provider = resolveProvider();
  } else if (customModels.length > 0) {
    provider = customModelToProvider(customModels[0]!);
  } else {
    provider = resolveProvider();
  }

  const missingKey =
    provider.type !== "ollama" &&
    !provider.apiKey &&
    (provider.type === "anthropic" ||
      provider.type === "openrouter" ||
      (provider.type === "openai" &&
        (provider.baseUrl ?? "").toLowerCase().includes("api.openai.com")));

  if (missingKey) {
    const keyName = provider.type === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    console.error(`Error: Missing ${keyName}. Set it in .env or environment.`);
    console.error(`Tip: Or configure models in custom-models.json`);
    process.exit(1);
  }

  if (printMode || (prompt && !process.stdin.isTTY)) {
    if (!prompt) {
      console.error("Error: No prompt provided. Use: agent-one run \"...\" or agent-one -p '...'");
      process.exit(1);
    }
    emitInvocationMarker({ sub: "legacy-print", task_cwd: cwd });
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const llm = new LlmClient(provider);
    const agent = new Agent(llm, registry, skills, { cwd });
    const result = await agent.run(prompt);
    process.stdout.write(result + "\n");
    return;
  }

  const { waitUntilExit } = render(
    React.createElement(App, { provider, skills, cwd, customModels }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

async function main() {
  const argv = process.argv.slice(2);
  const entryScript = fileURLToPath(import.meta.url);

  const cfg = loadAgentOneConfig();
  applyConfigToEnv(cfg);
  applyAgentOneApiKeyFromEnv();

  if (argv[0] === "_background-worker" && argv[1]) {
    await cmdBackgroundWorker(argv[1]);
    return;
  }

  if (argv.length === 0) {
    await runTuiMode();
    return;
  }

  const cmd = argv[0];

  if (cmd === "run") {
    const parsed = parseRunArgs(argv.slice(1));
    if ("error" in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    await cmdRun(parsed, entryScript);
    return;
  }

  if (cmd === "serve") {
    const parsed = parseServeArgs(argv.slice(1));
    if ("error" in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    await cmdServe(parsed, entryScript);
    return;
  }

  if (cmd === "team") {
    await cmdTeam(argv.slice(1));
    return;
  }

  if (cmd === "version" || cmd === "--version") {
    emitInvocationMarker({ sub: "version" });
    process.stdout.write(`AgentOne v${PKG_VERSION}\n`);
    return;
  }

  if (cmd === "setup-check") {
    cmdSetupCheck();
    return;
  }

  if (cmd === "login") {
    let apiKey: string | undefined;
    let provider: "openai" | "anthropic" = "openai";
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--api-key" && argv[i + 1]) {
        apiKey = argv[++i];
      } else if (argv[i] === "--provider" && argv[i + 1]) {
        const p = argv[++i];
        if (p === "anthropic") provider = "anthropic";
        else if (p === "openai") provider = "openai";
      }
    }
    await cmdLoginAsync(apiKey, provider);
    return;
  }

  if (cmd === "status") {
    cmdStatus(argv[1]);
    return;
  }

  if (cmd === "result") {
    cmdResult(argv[1]);
    return;
  }

  if (cmd === "cancel") {
    if (!argv[1]) {
      console.error("Usage: agent-one cancel <job-id>");
      process.exit(1);
    }
    cmdCancel(argv[1]);
    return;
  }

  await runTuiMode();
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
