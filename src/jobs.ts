import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const JOBS_DIR = path.join(os.homedir(), ".agent-one", "jobs");

export type JobRecord = {
  job_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress?: number;
  started_at: string;
  task: string;
  cwd: string;
  model?: string;
  pid?: number;
  output_file: string;
  error?: string;
  workspace_id?: string;
  agent_name?: string;
};

function ensureJobsDir(): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

export function jobsDir(): string {
  ensureJobsDir();
  return JOBS_DIR;
}

export function writeJob(job: JobRecord): void {
  ensureJobsDir();
  fs.writeFileSync(path.join(JOBS_DIR, `${job.job_id}.json`), JSON.stringify(job, null, 2), "utf8");
}

export function readJob(jobId: string): JobRecord | null {
  const p = path.join(JOBS_DIR, `${jobId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as JobRecord;
}

export function updateJob(jobId: string, patch: Partial<JobRecord>): void {
  const cur = readJob(jobId);
  if (!cur) return;
  const next = { ...cur, ...patch };
  writeJob(next as JobRecord);
}

export function latestJobFile(): string | null {
  ensureJobsDir();
  const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  const sorted = files
    .map((f) => path.join(JOBS_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return sorted[0] ?? null;
}

export function spawnBackgroundRun(job: JobRecord, entryScriptPath: string): void {
  const child = spawn(
    process.execPath,
    [entryScriptPath, "_background-worker", path.join(JOBS_DIR, `${job.job_id}.json`)],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
  );
  child.unref();
  updateJob(job.job_id, { pid: child.pid, status: "running" });
}
