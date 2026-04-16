import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { runAgentTask } from "./run-task.js";

const TeamMemberSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().positive().max(7200).optional(),
  env: z.record(z.string()).optional(),
});

const TeamConfigSchema = z.object({
  members: z.array(TeamMemberSchema).min(1),
});

const PlanStepSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  task: z.string().min(1),
  inputs: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  depends_on: z.array(z.string()).default([]),
  timeout_sec: z.number().int().positive().max(7200).optional(),
  retry: z.number().int().min(0).max(3).default(0),
  acceptance: z.array(z.string()).default([]),
});

const PlanSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  final_aggregation: z
    .object({
      format: z.enum(["markdown"]).default("markdown"),
      sections: z.array(z.string()).default(["Conclusion", "Risks", "Next Actions"]),
    })
    .default({
      format: "markdown",
      sections: ["Conclusion", "Risks", "Next Actions"],
    }),
});

type TeamConfig = z.infer<typeof TeamConfigSchema>;
type Plan = z.infer<typeof PlanSchema>;
type PlanStep = z.infer<typeof PlanStepSchema>;

type TeamInitOptions = {
  cwd: string;
  force: boolean;
  teamPath: string;
  schemaPath: string;
  examplePlanPath: string;
};

type TeamExecuteOptions = {
  cwd: string;
  teamPath: string;
  planPath: string;
  runDir: string;
  verbose: boolean;
};

type TeamPlanOptions = {
  cwd: string;
  teamPath: string;
  goal: string;
  outputPath: string;
  model?: string;
};

type TeamExecuteParseResult = { opts: TeamExecuteOptions } | { error: string };
type TeamInitParseResult = { opts: TeamInitOptions } | { error: string };
type TeamPlanParseResult = { opts: TeamPlanOptions } | { error: string };

type MemberInputSpec = {
  name: string;
  declaredInputs: string[];
  description?: string;
};

type StepAttemptResult = {
  attempt: number;
  status: "success" | "failed";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type StepResult = {
  stepId: string;
  agent: string;
  task: string;
  status: "success" | "failed" | "skipped";
  attempts: StepAttemptResult[];
  startedAt: string;
  endedAt: string;
  outputFile: string;
  error?: string;
};

type RunSummary = {
  runId: string;
  goal: string;
  status: "success" | "failed";
  startedAt: string;
  endedAt: string;
  planFile: string;
  teamFile: string;
  runDir: string;
  stepResults: StepResult[];
  finalReportFile: string;
};

const DEFAULT_TEAM_TEMPLATE = `# Team members used by "agent-one team execute"
members:
  - name: code_reviewer
    description: Review code changes and provide risk-focused findings.
    command:
      - "node"
      - "dist/index.js"
      - "run"
      - "{{task}}"
      - "--cwd"
      - "{{workspace}}"
      - "--format"
      - "markdown"
    timeoutSec: 180

  - name: test_runner
    description: Execute project tests.
    command:
      - "bash"
      - "-lc"
      - "{{task}}"
    timeoutSec: 180

  - name: oracle_dba_agent
    description: >
      Oracle DBA specialist. Must call real oracle-dba-agent CLI via Bash-compatible command.
      Explicit declared inputs: format, extra_flags.
    command:
      - "bash"
      - "-lc"
      - 'oracle-dba-agent run "{{task}}" --cwd "{{workspace}}" --format "\${ORACLE_DBA_FORMAT:-markdown}" \${ORACLE_DBA_EXTRA_FLAGS}'
    env:
      ORACLE_DBA_FORMAT: "{{inputs.format}}"
      ORACLE_DBA_EXTRA_FLAGS: "{{inputs.extra_flags}}"
    timeoutSec: 300
`;

const DEFAULT_PLAN_TEMPLATE = `{
  "goal": "Review the code and run tests",
  "steps": [
    {
      "id": "review",
      "agent": "code_reviewer",
      "task": "Review recent changes and list risks in markdown",
      "depends_on": [],
      "retry": 0,
      "acceptance": [
        "List severity and rationale",
        "Call out missing tests"
      ]
    },
    {
      "id": "test",
      "agent": "test_runner",
      "task": "npm test",
      "depends_on": [
        "review"
      ],
      "retry": 0,
      "acceptance": [
        "Return test summary output"
      ]
    }
  ],
  "final_aggregation": {
    "format": "markdown",
    "sections": [
      "Conclusion",
      "Risks",
      "Next Actions"
    ]
  }
}
`;

const PLAN_SCHEMA_TEMPLATE = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentOne Team Plan",
  "type": "object",
  "required": ["goal", "steps"],
  "properties": {
    "goal": { "type": "string", "minLength": 1 },
    "steps": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id", "agent", "task"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "agent": { "type": "string", "minLength": 1 },
          "task": { "type": "string", "minLength": 1 },
          "inputs": {
            "type": "object",
            "additionalProperties": { "type": ["string", "number", "boolean"] },
            "default": {}
          },
          "depends_on": {
            "type": "array",
            "items": { "type": "string" },
            "default": []
          },
          "timeout_sec": { "type": "integer", "minimum": 1, "maximum": 7200 },
          "retry": { "type": "integer", "minimum": 0, "maximum": 3, "default": 0 },
          "acceptance": {
            "type": "array",
            "items": { "type": "string" },
            "default": []
          }
        },
        "additionalProperties": false
      }
    },
    "final_aggregation": {
      "type": "object",
      "properties": {
        "format": { "type": "string", "enum": ["markdown"], "default": "markdown" },
        "sections": {
          "type": "array",
          "items": { "type": "string" },
          "default": ["Conclusion", "Risks", "Next Actions"]
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
`;

function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function readKeyPath(value: unknown, keyPath: string): unknown {
  const parts = keyPath.split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (typeof current !== "object" || current == null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function renderTemplate(input: string, ctx: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    const value = readKeyPath(ctx, key);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return String(value);
  });
}

function extractTemplatePaths(input: string): string[] {
  const results: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m[1]) results.push(m[1]);
  }
  return results;
}

function getMemberDeclaredInputs(member: TeamConfig["members"][number]): string[] {
  const set = new Set<string>();
  const allTemplateSources = [...member.command];
  if (member.cwd) allTemplateSources.push(member.cwd);
  if (member.env) allTemplateSources.push(...Object.values(member.env));

  for (const source of allTemplateSources) {
    for (const p of extractTemplatePaths(source)) {
      if (p.startsWith("inputs.") && p.length > "inputs.".length) {
        set.add(p.slice("inputs.".length));
      }
    }
  }
  return Array.from(set).sort();
}

function buildMemberInputSpecs(team: TeamConfig): MemberInputSpec[] {
  return team.members.map((m) => ({
    name: m.name,
    description: m.description,
    declaredInputs: getMemberDeclaredInputs(m),
  }));
}

async function loadTeamConfig(teamPath: string): Promise<TeamConfig> {
  const raw = await fsp.readFile(teamPath, "utf8");
  const parsed = parseYaml(raw);
  return TeamConfigSchema.parse(parsed);
}

async function loadPlan(planPath: string): Promise<Plan> {
  const raw = await fsp.readFile(planPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validatePlanObject(parsed);
}

function nowRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${iso}`;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function writeText(pathname: string, content: string): Promise<void> {
  await ensureDir(path.dirname(pathname));
  await fsp.writeFile(pathname, content, "utf8");
}

async function writeJson(pathname: string, obj: unknown): Promise<void> {
  await writeText(pathname, `${JSON.stringify(obj, null, 2)}\n`);
}

function commandToDisplay(cmd: string[], ctx: Record<string, unknown>): string {
  return cmd.map((part) => renderTemplate(part, ctx)).join(" ");
}

function runCommand(args: {
  command: string[];
  cwd: string;
  timeoutSec: number;
  env: Record<string, string>;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}> {
  return new Promise((resolve, reject) => {
    const [file, ...argv] = args.command;
    if (!file) {
      reject(new Error("Command is empty"));
      return;
    }
    const started = Date.now();
    const cp = spawn(file, argv, {
      cwd: args.cwd,
      env: args.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      cp.kill("SIGTERM");
    }, args.timeoutSec * 1000);

    cp.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (args.onStdoutChunk) args.onStdoutChunk(text);
    });
    cp.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (args.onStderrChunk) args.onStderrChunk(text);
    });

    cp.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reject(err);
    });

    cp.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

function toEnvRecord(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function isReady(step: PlanStep, completed: Set<string>): boolean {
  return step.depends_on.every((dep) => completed.has(dep));
}

function validatePlanObject(rawPlan: unknown, team?: TeamConfig): Plan {
  const plan = PlanSchema.parse(rawPlan);
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      throw new Error(`Duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) {
        throw new Error(`Step "${step.id}" depends on missing step "${dep}"`);
      }
    }
  }
  if (team) {
    const memberNames = new Set(team.members.map((m) => m.name));
    const inputSpecs = buildMemberInputSpecs(team);
    const declaredInputsByMember = new Map<string, Set<string>>(
      inputSpecs.map((spec) => [spec.name, new Set(spec.declaredInputs)]),
    );
    for (const step of plan.steps) {
      if (!memberNames.has(step.agent)) {
        throw new Error(
          `Step "${step.id}" references unknown agent "${step.agent}". Allowed agents: ${Array.from(
            memberNames,
          ).join(", ")}`,
        );
      }
      const declared = declaredInputsByMember.get(step.agent) ?? new Set<string>();
      for (const key of Object.keys(step.inputs ?? {})) {
        if (!declared.has(key)) {
          const allowed = Array.from(declared).sort();
          throw new Error(
            allowed.length > 0
              ? `Step "${step.id}" uses undeclared input "${key}" for agent "${step.agent}". Allowed inputs: ${allowed.join(", ")}`
              : `Step "${step.id}" uses undeclared input "${key}" for agent "${step.agent}". This agent declares no custom inputs in team config.`,
          );
        }
      }
    }
  }
  return plan;
}

function buildPlannerPrompt(goal: string, team: TeamConfig): string {
  const memberSpecs = buildMemberInputSpecs(team).map((spec) => ({
    name: spec.name,
    description: spec.description ?? "",
    declared_inputs: spec.declaredInputs,
  }));
  return [
    "You are a planning assistant for a multi-agent CLI execution system.",
    "Return ONLY one valid JSON object. No markdown. No code fences. No explanation.",
    "",
    "The JSON must match this shape exactly:",
    jsonString({
      goal: "string",
      steps: [
        {
          id: "string",
          agent: "string",
          task: "string",
          inputs: {},
          depends_on: [],
          timeout_sec: 120,
          retry: 0,
          acceptance: ["string"],
        },
      ],
      final_aggregation: {
        format: "markdown",
        sections: ["Conclusion", "Risks", "Next Actions"],
      },
    }),
    "",
    "Rules:",
    "- agent must be one of available members",
    "- For each step, inputs keys MUST be from selected agent declared_inputs only",
    "- If an agent has no declared_inputs, set inputs to {}",
    "- steps must be executable in dependency order",
    "- each step needs clear acceptance criteria",
    "- keep plan concise and practical",
    "- final_aggregation.format must be markdown",
    "",
    `Available members: ${jsonString(memberSpecs)}`,
    `Goal: ${goal}`,
  ].join("\n");
}

function extractJsonFromText(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Planner returned empty output");

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("Planner output does not contain a JSON object");
}

function buildFinalReport(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`# Team Execution Report`);
  lines.push("");
  lines.push(`- Run ID: \`${summary.runId}\``);
  lines.push(`- Goal: ${summary.goal}`);
  lines.push(`- Status: **${summary.status}**`);
  lines.push(`- Started: ${summary.startedAt}`);
  lines.push(`- Ended: ${summary.endedAt}`);
  lines.push("");
  lines.push("## Steps");
  lines.push("");

  for (const r of summary.stepResults) {
    lines.push(`### ${r.stepId} (${r.agent})`);
    lines.push(`- Status: **${r.status}**`);
    lines.push(`- Started: ${r.startedAt}`);
    lines.push(`- Ended: ${r.endedAt}`);
    if (r.error) lines.push(`- Error: ${r.error}`);
    lines.push(`- Output file: \`${r.outputFile}\``);
    lines.push("");
  }

  lines.push("## Next Actions");
  lines.push("");
  if (summary.status === "success") {
    lines.push("- Review per-step output files for details.");
    lines.push("- If needed, generate a refined plan for deeper analysis.");
  } else {
    lines.push("- Inspect the failed step output and stderr.");
    lines.push("- Create a repair/replan task and rerun with updated plan.");
  }
  lines.push("");
  return lines.join("\n");
}

async function executeStep(args: {
  step: PlanStep;
  team: TeamConfig;
  workspace: string;
  runDir: string;
  goal: string;
  completedResults: Record<string, StepResult>;
  verbose: boolean;
}): Promise<StepResult> {
  const { step, team, workspace, runDir, goal, completedResults, verbose } = args;
  const member = team.members.find((m) => m.name === step.agent);
  if (!member) {
    const now = new Date().toISOString();
    return {
      stepId: step.id,
      agent: step.agent,
      task: step.task,
      status: "failed",
      attempts: [],
      startedAt: now,
      endedAt: now,
      outputFile: path.join(runDir, `${step.id}.md`),
      error: `Unknown agent member: ${step.agent}`,
    };
  }

  const startedAt = new Date().toISOString();
  const attempts: StepAttemptResult[] = [];
  const retryCount = step.retry ?? 0;
  const timeoutSec = step.timeout_sec ?? member.timeoutSec ?? 120;
  if (verbose) {
    process.stdout.write(
      `[team][step:${step.id}] start agent=${step.agent} retry=${retryCount} timeout=${timeoutSec}s\n`,
    );
  }

  const ctxBase: Record<string, unknown> = {
    goal,
    task: step.task,
    step_id: step.id,
    timeout_sec: timeoutSec,
    workspace,
    run_dir: runDir,
    inputs: step.inputs,
    previous_steps: Object.keys(completedResults),
  };

  const outputFile = path.join(runDir, `${step.id}.md`);

  for (let attempt = 1; attempt <= retryCount + 1; attempt++) {
    const ctx: Record<string, unknown> = {
      ...ctxBase,
      attempt,
    };
    const renderedCommand = member.command.map((part) => renderTemplate(part, ctx));
    const memberCwdRaw = member.cwd ? renderTemplate(member.cwd, ctx) : workspace;
    const memberCwd = resolvePath(workspace, memberCwdRaw);
    const env = toEnvRecord(process.env);
    if (member.env) {
      for (const [k, v] of Object.entries(member.env)) {
        env[k] = renderTemplate(v, ctx);
      }
    }

    if (verbose) {
      process.stdout.write(
        `[team][step:${step.id}] attempt=${attempt} command=${commandToDisplay(member.command, ctx)}\n`,
      );
    }

    let attemptResult: StepAttemptResult;
    try {
      const rs = await runCommand({
        command: renderedCommand,
        cwd: memberCwd,
        timeoutSec,
        env,
        onStdoutChunk: verbose
          ? (chunk) => process.stdout.write(`[team][step:${step.id}][stdout] ${chunk}`)
          : undefined,
        onStderrChunk: verbose
          ? (chunk) => process.stdout.write(`[team][step:${step.id}][stderr] ${chunk}`)
          : undefined,
      });
      const status = rs.exitCode === 0 && !rs.timedOut ? "success" : "failed";
      let errText: string | undefined;
      if (rs.timedOut) {
        errText = `Timed out after ${timeoutSec}s`;
      } else if (rs.exitCode !== 0) {
        errText = `Exit code ${rs.exitCode ?? "unknown"}`;
      }
      attemptResult = {
        attempt,
        status,
        exitCode: rs.exitCode,
        durationMs: rs.durationMs,
        stdout: rs.stdout,
        stderr: rs.stderr,
        error: errText,
      };
    } catch (error) {
      attemptResult = {
        attempt,
        status: "failed",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        error: String(error),
      };
    }

    attempts.push(attemptResult);
    if (verbose) {
      process.stdout.write(
        `[team][step:${step.id}] attempt=${attempt} status=${attemptResult.status} durationMs=${attemptResult.durationMs}\n`,
      );
      if (attemptResult.error) {
        process.stdout.write(`[team][step:${step.id}] error=${attemptResult.error}\n`);
      }
    }

    const header = [
      `# Step ${step.id}`,
      ``,
      `- Agent: ${step.agent}`,
      `- Task: ${step.task}`,
      `- Attempt: ${attempt}`,
      `- Timeout: ${timeoutSec}s`,
      `- Command: \`${commandToDisplay(member.command, ctx)}\``,
      `- Status: **${attemptResult.status}**`,
      "",
      "## stdout",
      "",
      "```text",
      attemptResult.stdout.trimEnd(),
      "```",
      "",
      "## stderr",
      "",
      "```text",
      attemptResult.stderr.trimEnd(),
      "```",
      "",
    ].join("\n");
    await writeText(outputFile, header);

    if (attemptResult.status === "success") {
      const endedAt = new Date().toISOString();
      return {
        stepId: step.id,
        agent: step.agent,
        task: step.task,
        status: "success",
        attempts,
        startedAt,
        endedAt,
        outputFile,
      };
    }
  }

  const endedAt = new Date().toISOString();
  return {
    stepId: step.id,
    agent: step.agent,
    task: step.task,
    status: "failed",
    attempts,
    startedAt,
    endedAt,
    outputFile,
    error: attempts[attempts.length - 1]?.error ?? "Unknown step failure",
  };
}

export function parseTeamExecuteArgs(argv: string[], cwd = process.cwd()): TeamExecuteParseResult {
  const opts: TeamExecuteOptions = {
    cwd,
    teamPath: "team/team.yaml",
    planPath: "",
    runDir: ".agent-team-runs",
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd" && argv[i + 1]) {
      opts.cwd = argv[++i]!;
      continue;
    }
    if (arg === "--team" && argv[i + 1]) {
      opts.teamPath = argv[++i]!;
      continue;
    }
    if (arg === "--plan" && argv[i + 1]) {
      opts.planPath = argv[++i]!;
      continue;
    }
    if (arg === "--run-dir" && argv[i + 1]) {
      opts.runDir = argv[++i]!;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
      continue;
    }
    return { error: `Unknown option: ${arg}` };
  }
  if (!opts.planPath) {
    return { error: "Missing --plan <file>. Example: agent-one team execute --plan team/plan.json" };
  }
  return { opts };
}

export function parseTeamPlanArgs(argv: string[], cwd = process.cwd()): TeamPlanParseResult {
  const opts: TeamPlanOptions = {
    cwd,
    teamPath: "team/team.yaml",
    goal: "",
    outputPath: "team/plan.generated.json",
  };
  const goalParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd" && argv[i + 1]) {
      opts.cwd = argv[++i]!;
      continue;
    }
    if (arg === "--team" && argv[i + 1]) {
      opts.teamPath = argv[++i]!;
      continue;
    }
    if (arg === "--goal" && argv[i + 1]) {
      opts.goal = argv[++i]!;
      continue;
    }
    if (arg === "--output" && argv[i + 1]) {
      opts.outputPath = argv[++i]!;
      continue;
    }
    if (arg === "--model" && argv[i + 1]) {
      opts.model = argv[++i]!;
      continue;
    }
    if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    }
    goalParts.push(arg);
  }

  if (!opts.goal && goalParts.length > 0) {
    opts.goal = goalParts.join(" ").trim();
  }
  if (!opts.goal) {
    return {
      error:
        "Missing goal. Use --goal \"...\" or positional text. Example: agent-one team plan --goal \"review PR and test\"",
    };
  }
  return { opts };
}

export function parseTeamInitArgs(argv: string[], cwd = process.cwd()): TeamInitParseResult {
  const opts: TeamInitOptions = {
    cwd,
    force: false,
    teamPath: "team/team.yaml",
    schemaPath: "team/plan.schema.json",
    examplePlanPath: "team/example.plan.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd" && argv[i + 1]) {
      opts.cwd = argv[++i]!;
      continue;
    }
    if (arg === "--team" && argv[i + 1]) {
      opts.teamPath = argv[++i]!;
      continue;
    }
    if (arg === "--schema" && argv[i + 1]) {
      opts.schemaPath = argv[++i]!;
      continue;
    }
    if (arg === "--example-plan" && argv[i + 1]) {
      opts.examplePlanPath = argv[++i]!;
      continue;
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    return { error: `Unknown option: ${arg}` };
  }
  return { opts };
}

async function writeTemplateIfAllowed(
  filePath: string,
  content: string,
  force: boolean,
): Promise<"created" | "skipped"> {
  const exists = fs.existsSync(filePath);
  if (exists && !force) return "skipped";
  await writeText(filePath, content);
  return "created";
}

export async function initTeamMvp(opts: TeamInitOptions): Promise<string> {
  const workspace = resolvePath(process.cwd(), opts.cwd);
  const teamPath = resolvePath(workspace, opts.teamPath);
  const schemaPath = resolvePath(workspace, opts.schemaPath);
  const examplePlanPath = resolvePath(workspace, opts.examplePlanPath);

  const [teamState, schemaState, planState] = await Promise.all([
    writeTemplateIfAllowed(teamPath, DEFAULT_TEAM_TEMPLATE, opts.force),
    writeTemplateIfAllowed(schemaPath, PLAN_SCHEMA_TEMPLATE, opts.force),
    writeTemplateIfAllowed(examplePlanPath, DEFAULT_PLAN_TEMPLATE, opts.force),
  ]);

  return [
    `MVP files ready:`,
    `- ${teamPath} (${teamState})`,
    `- ${schemaPath} (${schemaState})`,
    `- ${examplePlanPath} (${planState})`,
  ].join("\n");
}

export async function executeTeamPlan(opts: TeamExecuteOptions): Promise<RunSummary> {
  const workspace = resolvePath(process.cwd(), opts.cwd);
  const teamPath = resolvePath(workspace, opts.teamPath);
  const planPath = resolvePath(workspace, opts.planPath);
  const runRoot = resolvePath(workspace, opts.runDir);

  const [team, plan] = await Promise.all([loadTeamConfig(teamPath), loadPlan(planPath)]);
  if (opts.verbose) {
    process.stdout.write(
      `[team] execute start team=${teamPath} plan=${planPath} runRoot=${runRoot}\n`,
    );
  }

  const runId = nowRunId();
  const runDir = path.join(runRoot, runId);
  await ensureDir(runDir);
  await writeJson(path.join(runDir, "plan.json"), plan);
  await writeJson(path.join(runDir, "team.snapshot.json"), team);

  const startedAt = new Date().toISOString();
  const completed = new Set<string>();
  const pending = [...plan.steps];
  const stepResults: StepResult[] = [];
  const resultByStep: Record<string, StepResult> = {};
  let failed = false;

  while (pending.length > 0) {
    const nextIdx = pending.findIndex((step) => isReady(step, completed));
    if (nextIdx < 0) {
      throw new Error("No executable step found. Check depends_on graph for cycle.");
    }
    const step = pending.splice(nextIdx, 1)[0]!;
    const result = await executeStep({
      step,
      team,
      workspace,
      runDir,
      goal: plan.goal,
      completedResults: resultByStep,
      verbose: opts.verbose,
    });
    stepResults.push(result);
    resultByStep[step.id] = result;
    await writeJson(path.join(runDir, `${step.id}.result.json`), result);
    if (result.status === "success") {
      completed.add(step.id);
      if (opts.verbose) {
        process.stdout.write(`[team][step:${step.id}] completed\n`);
      }
      continue;
    }
    failed = true;
    if (opts.verbose) {
      process.stdout.write(`[team][step:${step.id}] failed, stop remaining steps\n`);
    }
    break;
  }

  if (failed) {
    for (const step of pending) {
      const now = new Date().toISOString();
      const skipped: StepResult = {
        stepId: step.id,
        agent: step.agent,
        task: step.task,
        status: "skipped",
        attempts: [],
        startedAt: now,
        endedAt: now,
        outputFile: path.join(runDir, `${step.id}.md`),
        error: "Skipped because a previous step failed",
      };
      stepResults.push(skipped);
      await writeJson(path.join(runDir, `${step.id}.result.json`), skipped);
    }
  }

  const endedAt = new Date().toISOString();
  const summary: RunSummary = {
    runId,
    goal: plan.goal,
    status: failed ? "failed" : "success",
    startedAt,
    endedAt,
    planFile: planPath,
    teamFile: teamPath,
    runDir,
    stepResults,
    finalReportFile: path.join(runDir, "final.md"),
  };

  await writeJson(path.join(runDir, "summary.json"), summary);
  await writeText(summary.finalReportFile, buildFinalReport(summary));
  if (opts.verbose) {
    process.stdout.write(
      `[team] execute end status=${summary.status} summary=${path.join(runDir, "summary.json")}\n`,
    );
  }
  return summary;
}

export async function generateTeamPlan(opts: TeamPlanOptions): Promise<{
  planPath: string;
  goal: string;
  model?: string;
  rawResponse: string;
}> {
  const workspace = resolvePath(process.cwd(), opts.cwd);
  const teamPath = resolvePath(workspace, opts.teamPath);
  const outputPath = resolvePath(workspace, opts.outputPath);
  const team = await loadTeamConfig(teamPath);

  const plannerPrompt = buildPlannerPrompt(opts.goal, team);
  const rawResponse = await runAgentTask(plannerPrompt, workspace, opts.model);
  const jsonText = extractJsonFromText(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Planner did not return valid JSON: ${String(error)}`);
  }

  const plan = validatePlanObject(parsed, team);
  await writeJson(outputPath, plan);
  return { planPath: outputPath, goal: plan.goal, model: opts.model, rawResponse };
}

export function formatRunSummary(summary: RunSummary): string {
  const lines = [
    `Run ID: ${summary.runId}`,
    `Status: ${summary.status}`,
    `Run dir: ${summary.runDir}`,
    `Final report: ${summary.finalReportFile}`,
    "",
    "Steps:",
  ];
  for (const step of summary.stepResults) {
    lines.push(`- ${step.stepId} [${step.agent}] => ${step.status}`);
  }
  return lines.join("\n");
}

export function printTeamHelp(): string {
  return `
Team commands:
  agent-one team init [--cwd <dir>] [--team <file>] [--schema <file>] [--example-plan <file>] [--force]
  agent-one team plan --goal <text> [--team <file>] [--output <file>] [--model <name>] [--cwd <dir>]
  agent-one team execute --plan <file> [--team <file>] [--run-dir <dir>] [--verbose] [--cwd <dir>]

Examples:
  agent-one team init
  agent-one team plan --goal "review code and run tests"
  agent-one team execute --plan team/example.plan.json --verbose
`;
}

export type { TeamExecuteOptions, TeamInitOptions, TeamPlanOptions };
