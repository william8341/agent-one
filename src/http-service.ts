import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { type JobRecord, readJob, spawnBackgroundRun, writeJob } from "./jobs.js";

const submitSchema = z.object({
  workspace_id: z.string().optional(),
  agent_name: z.string().min(1),
  user_input: z.string().min(1),
});

const querySchema = z.object({
  execution_id: z.string().min(1),
});

export type HttpServiceOptions = {
  host: string;
  port: number;
  token: string;
  cwd: string;
  model?: string;
  entryScript: string;
};

type JsonObject = Record<string, unknown>;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: JsonObject): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { success: false, error: "Unauthorized" });
}

function invalidRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { success: false, error: message });
}

function buildJobFromSubmit(
  input: z.infer<typeof submitSchema>,
  opts: HttpServiceOptions,
): JobRecord {
  const executionId = randomUUID();
  const outputFile = path.join("/tmp", `agent-one-${executionId}.md`);
  return {
    job_id: executionId,
    status: "running",
    started_at: new Date().toISOString(),
    task: input.user_input,
    cwd: opts.cwd,
    model: opts.model,
    output_file: outputFile,
    workspace_id: input.workspace_id,
    agent_name: input.agent_name,
  };
}

function mapStatus(job: JobRecord): { status: string; status_code: string; status_desc: string } {
  if (job.status === "completed") {
    return { status: "成功", status_code: "success", status_desc: "任务处理完成" };
  }
  if (job.status === "running") {
    return { status: "执行中", status_code: "running", status_desc: "任务正在处理中" };
  }
  if (job.status === "cancelled") {
    return { status: "已取消", status_code: "cancelled", status_desc: "任务已取消" };
  }
  return { status: "失败", status_code: "failed", status_desc: job.error ?? "任务处理失败" };
}

function buildQueryPayload(job: JobRecord): JsonObject {
  const statusInfo = mapStatus(job);
  const outputText =
    job.status === "completed" && fs.existsSync(job.output_file)
      ? fs.readFileSync(job.output_file, "utf8")
      : job.status === "failed"
        ? `Error: ${job.error ?? "任务执行失败"}`
        : "";
  return {
    success: true,
    data: {
      agent_id: job.agent_name ?? "agent-one",
      execution_id: job.job_id,
      output_result: {
        evidence_items: {},
        text: outputText,
      },
      output_text: outputText,
      status: statusInfo.status,
      status_code: statusInfo.status_code,
      status_desc: statusInfo.status_desc,
      workspace_id: job.workspace_id ?? null,
    },
  };
}

function validateAuthorization(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  return auth === `Bearer ${token}`;
}

export function startHttpService(opts: HttpServiceOptions): Promise<void> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 404, { success: false, error: "Not Found" });
      return;
    }

    if (!validateAuthorization(req, opts.token)) {
      unauthorized(res);
      return;
    }

    if (req.url === "/api/external/agent-executions") {
      try {
        const body = await readJsonBody(req);
        const parsed = submitSchema.safeParse(body);
        if (!parsed.success) {
          invalidRequest(res, parsed.error.issues[0]?.message ?? "Invalid request");
          return;
        }
        const job = buildJobFromSubmit(parsed.data, opts);
        writeJob(job);
        spawnBackgroundRun(job, opts.entryScript);
        sendJson(res, 200, { execution_id: job.job_id });
      } catch (e) {
        invalidRequest(res, String(e));
      }
      return;
    }

    if (req.url === "/api/external/agent-executions/query") {
      try {
        const body = await readJsonBody(req);
        const parsed = querySchema.safeParse(body);
        if (!parsed.success) {
          invalidRequest(res, parsed.error.issues[0]?.message ?? "Invalid request");
          return;
        }
        const job = readJob(parsed.data.execution_id);
        if (!job) {
          sendJson(res, 404, { success: false, error: "Execution not found" });
          return;
        }
        sendJson(res, 200, buildQueryPayload(job));
      } catch (e) {
        invalidRequest(res, String(e));
      }
      return;
    }

    sendJson(res, 404, { success: false, error: "Not Found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      process.stdout.write(
        `HTTP service listening on http://${opts.host}:${opts.port} (workspace: ${opts.cwd})\n`,
      );
      resolve();
    });
  });
}
