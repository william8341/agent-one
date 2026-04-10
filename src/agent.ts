/**
 * Core Agent — think-act-observe loop with streaming, sub-agent spawning,
 * permission control, and error recovery.
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
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolName: string; args: unknown }
  | { type: "tool_result"; toolName: string; result: ToolResult }
  | { type: "turn_complete"; turn: number }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finalText: string }
  | { type: "error"; error: string };

// ─── Agent Class ─────────────────────────────────────────────────────────
export class Agent {
  private llm: LlmClient;
  private registry: ToolRegistry;
  private skills: Skill[];
  private maxTurns: number;
  private ctx: { cwd: string };
  private baseSystemPrompt: string;
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  // Permission callback — if set, asks user before executing non-read-only tools
  public onPermissionRequest?: (toolName: string, args: unknown) => Promise<boolean>;

  constructor(
    llm: LlmClient,
    registry: ToolRegistry,
    skills: Skill[],
    options: AgentOptions,
  ) {
    this.llm = llm;
    this.registry = registry;
    this.skills = skills;
    this.maxTurns = options.maxTurns ?? 15;
    this.ctx = { cwd: options.cwd };
    this.baseSystemPrompt =
      options.systemPrompt ?? buildDefaultSystemPrompt(this.skills, this.registry.list());
    this.registerUseSkillTool();
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  // ─── Non-streaming run (for sub-agents, CLI -p mode) ─────────────────
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

      // Append assistant message
      const assistantMsg: LlmMessage = {
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
      messages.push(assistantMsg);

      if (response.toolCalls.length === 0) {
        return finalText || "(No response)";
      }

      // Execute tool calls
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

  // ─── Streaming run (for TUI) ──────────────────────────────────────────
  async *runStreaming(prompt: string): AsyncGenerator<AgentEvent> {
    const messages: LlmMessage[] = [
      { role: "system", content: this.baseSystemPrompt },
      { role: "user", content: prompt },
    ];

    let finalText = "";

    for (let turn = 0; turn < this.maxTurns; turn++) {
      let turnText = "";
      const toolCalls: { id: string; name: string; argumentsText: string }[] = [];

      // Stream from LLM
      for await (const event of this.llm.stream(
        messages,
        this.registry.getOpenAIToolSchemas(),
      )) {
        if (event.type === "text_delta" && event.text) {
          turnText += event.text;
          yield { type: "text_delta", text: event.text };
        }
        if (event.type === "tool_call_start" && event.toolCall) {
          toolCalls.push(event.toolCall);
        }
        if (event.type === "done" && event.usage) {
          this.accumulateUsage(event.usage);
          yield { type: "usage", usage: this.getUsage() };
        }
        if (event.type === "error") {
          yield { type: "error", error: event.error ?? "Unknown stream error" };
          return;
        }
      }

      if (turnText) {
        finalText += (finalText ? "\n" : "") + turnText;
      }

      // Append assistant message
      const assistantMsg: LlmMessage = {
        role: "assistant",
        content: turnText || "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      messages.push(assistantMsg);

      if (toolCalls.length === 0) {
        yield { type: "done", finalText };
        return;
      }

      // Execute tool calls
      for (const tc of toolCalls) {
        yield { type: "tool_call", toolName: tc.name, args: tc.argumentsText };
        const result = await this.executeTool(tc.id, tc.name, tc.argumentsText);
        yield { type: "tool_result", toolName: tc.name, result };
        messages.push({
          role: "tool",
          content: result.content,
          tool_call_id: tc.id,
        });
      }

      yield { type: "turn_complete", turn };
    }

    yield { type: "done", finalText: `${finalText}\n\n(Reached max turns: ${this.maxTurns})`.trim() };
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

    // Permission check for non-read-only tools
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

  // ─── Skill as sub-agent ────────────────────────────────────────────────
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
          maxTurns: 5,
          systemPrompt: `${this.baseSystemPrompt}\n\n[Skill: ${skill.name}]\n${skill.systemPrompt}`,
        });
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
