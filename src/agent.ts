/**
 * Core Agent — think-act-observe loop with streaming, sub-agent spawning,
 * permission control, and error recovery.
 *
 * Sub-agent events bubble up with incremented `depth` so the TUI can
 * render nested indentation for skill execution.
 */
import { z } from "zod";
import { LlmClient } from "./llm.js";
import { ToolRegistry } from "./tools.js";
import type {
  AgentOptions,
  LlmMessage,
  LlmStreamEvent,
  Skill,
  Tool,
  ToolResult,
  TokenUsage,
  PermissionRequest,
} from "./types.js";

// ─── System Prompt Builder ───────────────────────────────────────────────
function buildDefaultSystemPrompt(skills: Skill[], tools: Tool[]): string {
  const skillsText =
    skills.length === 0
      ? "No skills loaded."
      : skills
          .map(
            (s) =>
              `- ${s.name}: ${s.description}${s.whenToUse ? ` (when: ${s.whenToUse})` : ""}`,
          )
          .join("\n");

  const toolsText = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return [
    "You are an execution-first coding agent deployed in a terminal environment.",
    "You have access to tools for file operations, shell commands, and code search.",
    "",
    "## Behavior Guidelines",
    "- Use tools when needed. Read files before modifying. Inspect errors and try a different approach.",
    "- Be concise and direct. Lead with the answer or action.",
    "- Only make changes that are directly requested.",
    "- Avoid introducing security vulnerabilities.",
    "- When a command fails, read the error carefully, gather more info, identify root cause, then try a different approach.",
    "- For problems that may repeat, use memory_search early; after a verified fix, offer memory_save (no secrets; use mark_private or redact sensitive bits).",
    "",
    "## Available Skills",
    skillsText,
    "",
    "## Available Tools",
    toolsText,
  ].join("\n");
}

// ─── Event types emitted during agent execution ─────────────────────────
export type AgentEvent =
  | { type: "text_delta"; text: string; depth: number }
  | { type: "tool_call"; toolName: string; args: string; argsSummary: string; depth: number }
  | { type: "tool_result"; toolName: string; result: ToolResult; depth: number }
  | { type: "turn_complete"; turn: number; depth: number }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "usage"; usage: TokenUsage }
  | { type: "skill_start"; skillName: string; task: string; depth: number }
  | { type: "skill_end"; skillName: string; ok: boolean; depth: number }
  | { type: "done"; finalText: string }
  | { type: "error"; error: string; depth: number };

// ─── Agent Class ─────────────────────────────────────────────────────────
export class Agent {
  private llm: LlmClient;
  private registry: ToolRegistry;
  private skills: Skill[];
  private maxTurns: number;
  private ctx: { cwd: string };
  private baseSystemPrompt: string;
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private depth: number;

  /** Callback for sub-agent events — the TUI subscribes to this */
  public onSubAgentEvent?: (event: AgentEvent) => void;

  // Permission callback — if set, asks user before executing non-read-only tools
  public onPermissionRequest?: (toolName: string, args: unknown) => Promise<boolean>;

  /** Set to true to abort the current streaming run */
  private _aborted = false;

  constructor(
    llm: LlmClient,
    registry: ToolRegistry,
    skills: Skill[],
    options: AgentOptions & { depth?: number },
  ) {
    this.llm = llm;
    this.registry = registry;
    this.skills = skills;
    this.maxTurns = options.maxTurns ?? 15;
    this.ctx = { cwd: options.cwd };
    this.depth = options.depth ?? 0;
    this.baseSystemPrompt =
      options.systemPrompt ?? buildDefaultSystemPrompt(this.skills, this.registry.list());
    this.registerUseSkillTool();
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  // ─── Non-streaming run (for CLI -p mode) ──────────────────────────────
  async run(prompt: string): Promise<string> {
    const messages: LlmMessage[] = [
      { role: "system", content: this.baseSystemPrompt },
      { role: "user", content: prompt },
    ];

    let finalText = "";

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this.llm.complete(
        messages,
        this.registry.getOpenAIToolSchemas(),
      );

      if (response.usage) this.accumulateUsage(response.usage);
      if (response.content) {
        finalText += (finalText ? "\n" : "") + response.content;
      }

      const assistantMsg: LlmMessage = {
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
      messages.push(assistantMsg);

      if (response.toolCalls.length === 0) {
        return finalText || "(No response)";
      }

      for (const tc of response.toolCalls) {
        const result = await this.executeTool(tc.id, tc.name, tc.argumentsText);
        messages.push({
          role: "tool",
          content: result.content,
          tool_call_id: tc.id,
        });
      }
    }

    return `${finalText}\n\n(Reached max turns: ${this.maxTurns})`.trim();
  }

  // ─── Persistent conversation history (for multi-turn) ───────────────
  private conversationHistory: LlmMessage[] = [];

  /** Reset conversation (called on /clear) */
  resetConversation(): void {
    this.conversationHistory = [];
  }

  /** Abort the current streaming run */
  abort(): void {
    this._aborted = true;
  }

  /** Whether the agent is currently aborted */
  get isAborted(): boolean {
    return this._aborted;
  }

  // ─── Streaming run (for TUI) — appends to persistent history ──────
  async *runStreaming(prompt: string): AsyncGenerator<AgentEvent> {
    this._aborted = false;

    const userMsg: LlmMessage = { role: "user", content: prompt };
    this.conversationHistory.push(userMsg);

    const messages: LlmMessage[] = [
      { role: "system", content: this.baseSystemPrompt },
      ...this.conversationHistory,
    ];

    let finalText = "";
    const d = this.depth;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      // ── Abort check at start of each turn ──
      if (this._aborted) {
        yield { type: "done", finalText: finalText || "(Aborted by user)" };
        return;
      }

      let turnText = "";
      const toolCalls: { id: string; name: string; argumentsText: string }[] = [];

      for await (const event of this.llm.stream(
        messages,
        this.registry.getOpenAIToolSchemas(),
      )) {
        if (this._aborted) break;
        if (event.type === "text_delta" && event.text) {
          turnText += event.text;
          yield { type: "text_delta", text: event.text, depth: d };
        }
        if (event.type === "tool_call_start" && event.toolCall) {
          toolCalls.push(event.toolCall);
        }
        if (event.type === "done" && event.usage) {
          this.accumulateUsage(event.usage);
          yield { type: "usage", usage: this.getUsage() };
        }
        if (event.type === "error") {
          yield { type: "error", error: event.error ?? "Unknown stream error", depth: d };
          return;
        }
      }

      if (this._aborted) {
        if (turnText) finalText += (finalText ? "\n" : "") + turnText;
        yield { type: "done", finalText: finalText || "(Aborted by user)" };
        return;
      }

      if (turnText) {
        finalText += (finalText ? "\n" : "") + turnText;
      }

      const assistantMsg: LlmMessage = {
        role: "assistant",
        content: turnText || "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      messages.push(assistantMsg);
      this.conversationHistory.push(assistantMsg);

      if (toolCalls.length === 0) {
        yield { type: "done", finalText };
        return;
      }

      // Execute tool calls — use_skill is handled specially via streaming
      for (const tc of toolCalls) {
        if (this._aborted) {
          yield { type: "done", finalText: finalText || "(Aborted by user)" };
          return;
        }
        const summary = this.summarizeToolArgs(tc.name, tc.argumentsText);
        yield { type: "tool_call", toolName: tc.name, args: tc.argumentsText, argsSummary: summary, depth: d };

        const result = await this.executeToolStreaming(tc.id, tc.name, tc.argumentsText);
        yield { type: "tool_result", toolName: tc.name, result, depth: d };

        const toolResultMsg: LlmMessage = {
          role: "tool",
          content: result.content,
          tool_call_id: tc.id,
        };
        messages.push(toolResultMsg);
        this.conversationHistory.push(toolResultMsg);
      }

      yield { type: "turn_complete", turn, depth: d };
    }

    yield { type: "done", finalText: `${finalText}\n\n(Reached max turns: ${this.maxTurns})`.trim() };
  }

  /** Create a human-readable summary of tool args for TUI display */
  private summarizeToolArgs(toolName: string, argsText: string): string {
    try {
      const args = JSON.parse(argsText || "{}") as Record<string, unknown>;
      switch (toolName) {
        case "shell":
          return String(args.command ?? "");
        case "read_file":
        case "write_file":
        case "edit_file":
          return String(args.path ?? "");
        case "glob_files":
          return String(args.pattern ?? "");
        case "search":
          return `${args.pattern ?? ""}${args.path ? ` in ${args.path}` : ""}`;
        case "list_dir":
          return String(args.path ?? ".");
        case "web_fetch":
          return String(args.url ?? "");
        case "use_skill":
          return `${args.skillName ?? "?"}: ${String(args.task ?? "").slice(0, 80)}`;
        default: {
          const s = JSON.stringify(args);
          return s.length > 100 ? s.slice(0, 100) + "..." : s;
        }
      }
    } catch {
      return argsText.slice(0, 100);
    }
  }

  // ─── Tool execution — streaming version for use_skill ──────────────
  private async executeToolStreaming(
    callId: string,
    name: string,
    argsText: string,
  ): Promise<ToolResult> {
    // For use_skill, run sub-agent with streaming and emit events
    if (name === "use_skill") {
      return this.executeSkillStreaming(argsText);
    }
    return this.executeTool(callId, name, argsText);
  }

  private async executeSkillStreaming(argsText: string): Promise<ToolResult> {
    let parsedArgs: { skillName: string; task: string };
    try {
      parsedArgs = JSON.parse(argsText || "{}");
    } catch {
      return { ok: false, content: "Invalid skill arguments" };
    }

    const skill = this.skills.find((s) => s.name === parsedArgs.skillName);
    if (!skill) return { ok: false, content: `Skill not found: ${parsedArgs.skillName}` };

    const childRegistry = new ToolRegistry();
    for (const t of this.registry.list()) {
      if (t.name === "use_skill") continue;
      if (!skill.allowedTools || skill.allowedTools.includes(t.name)) {
        childRegistry.register(t);
      }
    }

    const childDepth = this.depth + 1;
    const child = new Agent(this.llm, childRegistry, [], {
      cwd: this.ctx.cwd,
      maxTurns: 15,
      depth: childDepth,
      systemPrompt: `${this.baseSystemPrompt}\n\n[Skill: ${skill.name}]\n${skill.systemPrompt}`,
    });
    child.onPermissionRequest = this.onPermissionRequest;

    // Emit skill_start
    this.emitSubEvent({ type: "skill_start", skillName: skill.name, task: parsedArgs.task, depth: childDepth });

    let finalText = "";
    let ok = true;

    try {
      for await (const event of child.runStreaming(parsedArgs.task)) {
        // Bubble every child event up to the TUI
        this.emitSubEvent(event);

        if (event.type === "done") {
          finalText = event.finalText;
        }
        if (event.type === "error") {
          ok = false;
          finalText = event.error;
        }
      }
    } catch (error) {
      ok = false;
      finalText = String(error);
    }

    this.emitSubEvent({ type: "skill_end", skillName: skill.name, ok, depth: childDepth });

    return { ok, content: finalText || "(No output from skill)" };
  }

  private emitSubEvent(event: AgentEvent): void {
    if (this.onSubAgentEvent) {
      this.onSubAgentEvent(event);
    }
  }

  // ─── Tool execution with validation ───────────────────────────────────
  private async executeTool(
    callId: string,
    name: string,
    argsText: string,
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return { ok: false, content: `Tool not found: ${name}` };
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(argsText || "{}");
    } catch {
      return { ok: false, content: "Invalid tool arguments JSON" };
    }

    const check = tool.inputSchema.safeParse(parsedArgs);
    if (!check.success) {
      return {
        ok: false,
        content: `Input validation failed: ${check.error.message}`,
      };
    }

    if (!tool.isReadOnly && this.onPermissionRequest) {
      const allowed = await this.onPermissionRequest(name, check.data);
      if (!allowed) {
        return { ok: false, content: `Tool use denied by user: ${name}` };
      }
    }

    try {
      return await tool.execute(check.data, this.ctx);
    } catch (error) {
      return { ok: false, content: `Tool execution error: ${String(error)}` };
    }
  }

  // ─── Skill registration (use_skill tool) ───────────────────────────────
  private registerUseSkillTool(): void {
    const skillNames = this.skills.map((s) => s.name);
    if (skillNames.length === 0) return;

    const skillNameSchema = z.enum(skillNames as [string, ...string[]]);

    this.registry.register({
      name: "use_skill",
      description: "Invoke a skill to solve a sub-task. Skills are specialized agents.",
      inputSchema: z.object({
        skillName: skillNameSchema,
        task: z.string().min(1).describe("Task description for the skill"),
      }),
      // execute is only used in non-streaming run()
      execute: async ({ skillName, task }) => {
        const skill = this.skills.find((s) => s.name === skillName);
        if (!skill) return { ok: false, content: `Skill not found: ${skillName}` };

        const childRegistry = new ToolRegistry();
        for (const t of this.registry.list()) {
          if (t.name === "use_skill") continue;
          if (!skill.allowedTools || skill.allowedTools.includes(t.name)) {
            childRegistry.register(t);
          }
        }

        const child = new Agent(this.llm, childRegistry, [], {
          cwd: this.ctx.cwd,
          maxTurns: 15,
          depth: this.depth + 1,
          systemPrompt: `${this.baseSystemPrompt}\n\n[Skill: ${skill.name}]\n${skill.systemPrompt}`,
        });
        child.onPermissionRequest = this.onPermissionRequest;
        const answer = await child.run(task);
        return { ok: true, content: answer };
      },
    });
  }

  private accumulateUsage(usage: TokenUsage): void {
    this.totalUsage.promptTokens += usage.promptTokens;
    this.totalUsage.completionTokens += usage.completionTokens;
    this.totalUsage.totalTokens += usage.totalTokens;
  }
}
