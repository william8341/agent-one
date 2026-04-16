/**
 * Tool system — Registry + built-in tools (file, shell, search, memory, …).
 * Schema-driven with Zod validation + automatic JSON Schema generation for LLM.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { deleteSolution, saveSolution, searchSolutions, SOLUTIONS_DIR } from "./solution-memory.js";

const execAsync = promisify(exec);

// ─── Tool Registry ───────────────────────────────────────────────────────
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register<I>(tool: Tool<I>): void {
    this.tools.set(tool.name, tool as Tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  getOpenAIToolSchemas() {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.inputSchema, { target: "openAi" }),
      },
    }));
  }
}

// ─── Path resolution ─────────────────────────────────────────────────────
function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

// ─── Built-in Tools ──────────────────────────────────────────────────────
export function registerBuiltinTools(registry: ToolRegistry): void {
  // 1. Shell — execute commands
  registry.register({
    name: "shell",
    description:
      "Execute a shell command in the workspace. Returns stdout+stderr. Use for builds, git, installs, etc.",
    inputSchema: z.object({
      command: z.string().min(1).describe("Shell command to execute"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(120_000)
        .default(30_000)
        .describe("Timeout in milliseconds"),
    }),
    isReadOnly: false,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: ctx.cwd,
          timeout: args.timeoutMs,
          maxBuffer: 1024 * 1024 * 4,
          env: { ...process.env, TERM: "dumb" },
        });
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
        return { ok: true, content: out || "(Command succeeded with no output)" };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
        const body =
          `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "Unknown error";
        return { ok: false, content: `Exit code: ${err.code ?? -1}\n${body}` };
      }
    },
  });

  // 2. Read file
  registry.register({
    name: "read_file",
    description: "Read a UTF-8 text file. Returns full file content. Use to inspect source code.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File path (absolute or relative to cwd)"),
      offset: z.number().int().min(0).optional().describe("Start line (0-based)"),
      limit: z.number().int().positive().optional().describe("Max number of lines to read"),
    }),
    isReadOnly: true,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const fullPath = resolvePath(ctx.cwd, args.path);
        let content = await readFile(fullPath, "utf8");
        if (args.offset !== undefined || args.limit !== undefined) {
          const lines = content.split("\n");
          const start = args.offset ?? 0;
          const end = args.limit ? start + args.limit : lines.length;
          content = lines.slice(start, end).join("\n");
        }
        return { ok: true, content: content || "(empty file)" };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  // 3. Write file
  registry.register({
    name: "write_file",
    description:
      "Write UTF-8 text content to a file. Creates parent directories if needed.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File path"),
      content: z.string().describe("File content to write"),
    }),
    isReadOnly: false,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const fullPath = resolvePath(ctx.cwd, args.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, args.content, "utf8");
        return { ok: true, content: `Wrote ${args.path} (${args.content.length} chars)` };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  // 4. Edit file (precise string replacement)
  registry.register({
    name: "edit_file",
    description:
      "Perform exact string replacement in a file. old_string must match exactly one occurrence.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File path"),
      old_string: z.string().min(1).describe("Exact text to find"),
      new_string: z.string().describe("Replacement text"),
    }),
    isReadOnly: false,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const fullPath = resolvePath(ctx.cwd, args.path);
        const content = await readFile(fullPath, "utf8");
        const idx = content.indexOf(args.old_string);
        if (idx === -1) {
          return { ok: false, content: "old_string not found in file" };
        }
        const lastIdx = content.lastIndexOf(args.old_string);
        if (idx !== lastIdx) {
          return {
            ok: false,
            content: "old_string matches multiple locations. Provide more context to make it unique.",
          };
        }
        const updated = content.replace(args.old_string, args.new_string);
        await writeFile(fullPath, updated, "utf8");
        return { ok: true, content: `Edited ${args.path}` };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  // 5. Glob files
  registry.register({
    name: "glob_files",
    description: "Find files matching a glob pattern in workspace.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Glob pattern (e.g., '**/*.ts')"),
    }),
    isReadOnly: true,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const files = await fg(args.pattern, {
          cwd: ctx.cwd,
          dot: true,
          onlyFiles: true,
        });
        return { ok: true, content: files.join("\n") || "(No files matched)" };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  // 6. Search (grep)
  registry.register({
    name: "search",
    description:
      "Search file contents using regex. Returns matching lines with file paths and line numbers.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Regex pattern to search for"),
      path: z.string().optional().describe("Directory or file to search in (default: cwd)"),
      glob: z.string().optional().describe("File glob filter (e.g., '*.ts')"),
    }),
    isReadOnly: true,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const searchPath = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
        // Check if search target exists
        await stat(searchPath);
        const globPart = args.glob ? ` --include='${args.glob}'` : "";
        const { stdout } = await execAsync(
          `grep -rn --color=never${globPart} '${args.pattern.replace(/'/g, "'\\''")}' '${searchPath}' | head -100`,
          { cwd: ctx.cwd, timeout: 15_000, maxBuffer: 1024 * 1024 * 2 },
        );
        return { ok: true, content: stdout.trim() || "(No matches)" };
      } catch (error) {
        const err = error as { code?: number; stdout?: string };
        if (err.code === 1) return { ok: true, content: "(No matches)" };
        return { ok: false, content: String(error) };
      }
    },
  });

  // 7. List directory
  registry.register({
    name: "list_dir",
    description:
      "List directory contents with file types and sizes. Use to explore project structure.",
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path (default: cwd)"),
      depth: z.number().int().min(1).max(5).default(1).describe("Recursion depth (1-5)"),
    }),
    isReadOnly: true,
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const p = args.path ?? ".";
        const d = args.depth ?? 1;
        const fullPath = resolvePath(ctx.cwd, p);
        const { stdout } = await execAsync(
          `find '${fullPath}' -maxdepth ${d} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`,
          { cwd: ctx.cwd, timeout: 10_000, maxBuffer: 1024 * 1024 },
        );
        return { ok: true, content: stdout.trim() || "(Empty directory)" };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  // 8. Web fetch
  registry.register({
    name: "web_fetch",
    description:
      "Fetch content from a URL. Returns the response body as text (HTML/JSON/plain). Use for APIs and web pages.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
      headers: z.array(z.object({
        name: z.string(),
        value: z.string(),
      })).optional().describe("HTTP headers as name/value pairs"),
      body: z.string().optional().describe("Request body (for POST)"),
    }),
    isReadOnly: true,
    async execute(args): Promise<ToolResult> {
      try {
        const headerObj: Record<string, string> = {};
        if (args.headers) {
          for (const h of args.headers) headerObj[h.name] = h.value;
        }
        const init: RequestInit = {
          method: args.method,
          headers: Object.keys(headerObj).length > 0 ? headerObj : undefined,
          body: args.body,
        };
        const res = await fetch(args.url, init);
        const text = await res.text();
        const truncated = text.length > 10_000 ? text.slice(0, 10_000) + "\n...(truncated)" : text;
        return {
          ok: res.ok,
          content: `HTTP ${res.status}\n${truncated}`,
        };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  // 9. Todo write (task tracking in agent loop)
  registry.register({
    name: "todo_write",
    description:
      "Create or update a task list to track progress. Use when working on multi-step tasks.",
    inputSchema: z.object({
      todos: z.array(z.object({
        content: z.string().describe("Task description"),
        status: z.enum(["pending", "in_progress", "completed"]),
      })).describe("Full todo list (replaces previous)"),
    }),
    isReadOnly: true,
    async execute(args): Promise<ToolResult> {
      const icons = { pending: "○", in_progress: "◐", completed: "●" };
      const lines = args.todos.map(
        (t: { content: string; status: "pending" | "in_progress" | "completed" }) =>
          `  ${icons[t.status]} ${t.content}`,
      );
      return { ok: true, content: "Tasks:\n" + lines.join("\n") };
    },
  });

  // 10. Ask user (interactive question in agent loop)
  registry.register({
    name: "ask_user",
    description:
      "Ask the user a clarifying question when you need more information. The user's answer will be returned.",
    inputSchema: z.object({
      question: z.string().min(1).describe("The question to ask the user"),
    }),
    isReadOnly: true,
    async execute(args): Promise<ToolResult> {
      // In TUI mode, the question is shown and the agent loop will pause
      // until the next user message provides the answer.
      return {
        ok: true,
        content: `[QUESTION FOR USER] ${args.question}\n\nPlease wait for the user's response.`,
      };
    },
  });

  // 11–13. Local solution memory (~/.agent-one/solutions/)
  registry.register({
    name: "memory_search",
    description:
      "Search past saved successful solutions (local Markdown under ~/.agent-one/solutions). " +
      "Use before tackling a problem that may resemble a previous fix. " +
      "Private entries are omitted unless include_private is true.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Keywords to match against title, problem, solution, tags (space-separated AND match)",
        ),
      tags: z.array(z.string()).optional().describe("Optional: all of these tags must match"),
      include_private: z
        .boolean()
        .default(false)
        .describe("Set true only to include entries marked private"),
      limit: z.number().int().positive().max(20).default(5),
    }),
    isReadOnly: true,
    async execute(args): Promise<ToolResult> {
      try {
        const text = await searchSolutions({
          query: args.query,
          tags: args.tags ?? [],
          includePrivate: args.include_private ?? false,
          limit: args.limit ?? 5,
        });
        return { ok: true, content: text };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  registry.register({
    name: "memory_save",
    description:
      "Save a successful fix to local memory for future sessions. " +
      "Omit secrets; use mark_private for sensitive-but-needed notes, or redact before saving. " +
      `Stored under ${SOLUTIONS_DIR}`,
    inputSchema: z.object({
      title: z.string().min(1).describe("Short name for this solution"),
      problem: z.string().min(1).describe("What was wrong or the error context (no secrets)"),
      solution: z.string().min(1).describe("What worked: commands, files changed, verification"),
      tags: z.array(z.string()).default([]).describe("Labels for search, e.g. npm, docker, oracle"),
      mark_private: z
        .boolean()
        .default(false)
        .describe("If true, entry is hidden from default memory_search"),
    }),
    isReadOnly: false,
    async execute(args): Promise<ToolResult> {
      try {
        const { id, path } = await saveSolution({
          title: args.title,
          problem: args.problem,
          solution: args.solution,
          tags: args.tags ?? [],
          markPrivate: args.mark_private ?? false,
        });
        return {
          ok: true,
          content: `Saved solution id=${id}\nfile=${path}`,
        };
      } catch (error) {
        return { ok: false, content: String(error) };
      }
    },
  });

  registry.register({
    name: "memory_delete",
    description:
      "Permanently delete a saved solution by id (from memory_save output or memory_search heading). " +
      "Use to remove obsolete or accidentally stored entries.",
    inputSchema: z.object({
      id: z.string().min(1).describe("Solution id, e.g. sol-1730000000000-abc123"),
    }),
    isReadOnly: false,
    async execute(args): Promise<ToolResult> {
      const r = await deleteSolution(args.id.trim());
      return { ok: r.ok, content: r.message };
    },
  });
}
