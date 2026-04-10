/**
 * App — root TUI component. Composes Logo, MessageList, InputBox, StatusBar,
 * PermissionDialog. Drives the Agent streaming loop.
 *
 * Command dispatch by type:
 *   local     → execute locally, display result text. No agent loop.
 *   prompt    → expand to prompt string, feed into agent.runStreaming().
 *   local-jsx → (reserved) same as local for now.
 *
 * Sub-agent events bubble up via onSubAgentEvent with depth for indentation.
 */
import React, { useCallback, useEffect, useRef } from "react";
import { Box, useApp, useInput } from "ink";
import { Logo } from "./Logo.js";
import { StatusBar } from "./StatusBar.js";
import { MessageList } from "./MessageList.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { useStore } from "./hooks.js";
import { createStore, type Store } from "../store.js";
import { Agent, type AgentEvent } from "../agent.js";
import { LlmClient } from "../llm.js";
import { ToolRegistry, registerBuiltinTools } from "../tools.js";
import { parseSlashCommand, createBuiltinCommands, findCommand } from "../commands.js";
import type {
  AppState,
  UIMessage,
  ProviderConfig,
  CustomModelEntry,
  Skill,
  PermissionRequest,
  CommandContext,
} from "../types.js";

// ─── Create initial state ────────────────────────────────────────────────
function createInitialState(provider: ProviderConfig): AppState {
  return {
    status: "idle",
    messages: [],
    provider,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    inputHistory: [],
    historyIndex: -1,
    showPermission: null,
    errorMessage: null,
    autoRun: false,
  };
}

let msgIdCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++msgIdCounter}`;
}

// ─── App Props ───────────────────────────────────────────────────────────
interface AppProps {
  provider: ProviderConfig;
  skills: Skill[];
  cwd: string;
  customModels: CustomModelEntry[];
}

export function App({ provider, skills, cwd, customModels }: AppProps): React.ReactElement {
  const storeRef = useRef<Store<AppState>>(createStore(createInitialState(provider)));
  const store = storeRef.current;
  const state = useStore(store);
  const { exit } = useApp();
  const agentRef = useRef<Agent | null>(null);

  // ─── Helper: push a sub-agent event into the message list ─────────
  const handleSubAgentEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "skill_start": {
          store.setState((s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: nextId(),
                role: "system" as const,
                content: `▶ [${event.skillName}] ${event.task}`,
                timestamp: Date.now(),
                depth: event.depth,
              },
            ],
          }));
          break;
        }
        case "text_delta": {
          // Accumulate into the last streaming assistant message at this depth
          store.setState((s) => {
            const msgs = [...s.messages];
            // Find the last streaming assistant msg at this depth
            let idx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i]!;
              if (m.role === "assistant" && m.isStreaming && (m.depth ?? 0) === event.depth) {
                idx = i;
                break;
              }
            }
            if (idx >= 0) {
              msgs[idx] = {
                ...msgs[idx]!,
                content: msgs[idx]!.content + event.text,
                timestamp: Date.now(),
              };
            } else {
              msgs.push({
                id: nextId(),
                role: "assistant" as const,
                content: event.text,
                timestamp: Date.now(),
                isStreaming: true,
                depth: event.depth,
              });
            }
            return { ...s, messages: msgs };
          });
          break;
        }
        case "tool_call": {
          store.setState((s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: nextId(),
                role: "tool" as const,
                content: "",
                toolName: event.toolName,
                toolArgs: event.argsSummary,
                timestamp: Date.now(),
                depth: event.depth,
              },
            ],
          }));
          break;
        }
        case "tool_result": {
          store.setState((s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: nextId(),
                role: "tool" as const,
                content: event.result.content,
                toolName: event.toolName,
                timestamp: Date.now(),
                isError: !event.result.ok,
                depth: event.depth,
              },
            ],
          }));
          break;
        }
        case "skill_end": {
          // Finalize any streaming sub-agent text at this depth
          store.setState((s) => {
            const msgs = s.messages.map((m) =>
              m.role === "assistant" && m.isStreaming && (m.depth ?? 0) === event.depth
                ? { ...m, isStreaming: false }
                : m,
            );
            msgs.push({
              id: nextId(),
              role: "system" as const,
              content: `${event.ok ? "✓" : "✗"} [${event.skillName}] ${event.ok ? "completed" : "failed"}`,
              timestamp: Date.now(),
              depth: event.depth,
            });
            return { ...s, messages: msgs };
          });
          break;
        }
        case "error": {
          store.setState((s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: nextId(),
                role: "system" as const,
                content: `Error: ${event.error}`,
                timestamp: Date.now(),
                isError: true,
                depth: event.depth,
              },
            ],
          }));
          break;
        }
        // usage, done, turn_complete — ignored for sub-agents display
      }
    },
    [store],
  );

  // Build agent on provider change
  useEffect(() => {
    const currentProvider = store.getState().provider;
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const llm = new LlmClient(currentProvider);
    const agent = new Agent(llm, registry, skills, { cwd });

    agent.onPermissionRequest = (toolName, args) => {
      if (store.getState().autoRun) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        store.setState((s) => ({
          ...s,
          showPermission: { toolName, args, resolve } as PermissionRequest,
        }));
      });
    };

    // Wire up sub-agent event handler
    agent.onSubAgentEvent = handleSubAgentEvent;

    agentRef.current = agent;
  }, [state.provider, skills, cwd, store, handleSubAgentEvent]);

  // ─── Build command context ────────────────────────────────────────────
  const buildCommandCtx = useCallback((): CommandContext => ({
    setState: (fn) => store.setState(fn),
    getState: () => store.getState(),
    customModels,
    cwd,
    skills,
  }), [store, customModels, cwd, skills]);

  // ─── Run agent streaming loop ─────────────────────────────────────────
  const runAgent = useCallback(
    async (prompt: string, displayAsUser?: string) => {
      const userContent = displayAsUser ?? prompt;
      const userMsg: UIMessage = {
        id: nextId(),
        role: "user",
        content: userContent,
        timestamp: Date.now(),
        depth: 0,
      };
      store.setState((s) => ({
        ...s,
        messages: [...s.messages, userMsg],
        status: "thinking",
      }));

      const agent = agentRef.current;
      if (!agent) return;

      const assistantMsgId = nextId();
      let assistantText = "";

      try {
        for await (const event of agent.runStreaming(prompt)) {
          switch (event.type) {
            case "text_delta": {
              assistantText += event.text;
              store.setState((s) => {
                const msgs = [...s.messages];
                const existing = msgs.findIndex((m) => m.id === assistantMsgId);
                const msg: UIMessage = {
                  id: assistantMsgId,
                  role: "assistant",
                  content: assistantText,
                  timestamp: Date.now(),
                  isStreaming: true,
                  depth: 0,
                };
                if (existing >= 0) {
                  msgs[existing] = msg;
                } else {
                  msgs.push(msg);
                }
                return { ...s, messages: msgs, status: "streaming" };
              });
              break;
            }
            case "tool_call": {
              const callMsg: UIMessage = {
                id: nextId(),
                role: "tool",
                content: "",
                toolName: event.toolName,
                toolArgs: event.argsSummary,
                timestamp: Date.now(),
                depth: event.depth,
              };
              store.setState((s) => ({
                ...s,
                status: "tool_running",
                messages: [...s.messages, callMsg],
              }));
              break;
            }
            case "tool_result": {
              // Skip displaying use_skill result — sub-agent events already shown
              if (event.toolName === "use_skill") break;
              const toolMsg: UIMessage = {
                id: nextId(),
                role: "tool",
                content: event.result.content,
                toolName: event.toolName,
                timestamp: Date.now(),
                isError: !event.result.ok,
                depth: event.depth,
              };
              store.setState((s) => ({ ...s, messages: [...s.messages, toolMsg] }));
              break;
            }
            case "usage": {
              store.setState((s) => ({ ...s, usage: event.usage }));
              break;
            }
            case "done": {
              store.setState((s) => {
                const msgs = s.messages.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, isStreaming: false, content: assistantText || event.finalText }
                    : m,
                );
                if (!msgs.find((m) => m.id === assistantMsgId) && event.finalText) {
                  msgs.push({
                    id: assistantMsgId,
                    role: "assistant",
                    content: event.finalText,
                    timestamp: Date.now(),
                    depth: 0,
                  });
                }
                return { ...s, messages: msgs, status: "idle" };
              });
              break;
            }
            case "error": {
              store.setState((s) => ({
                ...s,
                status: "error",
                errorMessage: event.error,
                messages: [
                  ...s.messages,
                  {
                    id: nextId(),
                    role: "system" as const,
                    content: `Error: ${event.error}`,
                    timestamp: Date.now(),
                    isError: true,
                    depth: event.depth,
                  },
                ],
              }));
              break;
            }
          }
        }
      } catch (error) {
        store.setState((s) => ({
          ...s,
          status: "error",
          errorMessage: String(error),
          messages: [
            ...s.messages,
            {
              id: nextId(),
              role: "system" as const,
              content: `Error: ${String(error)}`,
              timestamp: Date.now(),
              isError: true,
            },
          ],
        }));
      }

      store.setState((s) => (s.status !== "idle" ? { ...s, status: "idle" } : s));
    },
    [store],
  );

  // ─── Handle input submission ─────────────────────────────────────────
  const handleSubmit = useCallback(
    async (input: string) => {
      store.setState((s) => ({
        ...s,
        inputHistory: [...s.inputHistory, input],
        historyIndex: -1,
        errorMessage: null,
      }));

      const parsed = parseSlashCommand(input);
      if (parsed) {
        const commands = createBuiltinCommands();
        const matched = findCommand(parsed.name, commands);

        if (matched) {
          const ctx = buildCommandCtx();

          switch (matched.type) {
            case "local":
            case "local-jsx": {
              const result = await matched.execute(parsed.args, ctx);
              switch (result.type) {
                case "text":
                  store.setState((s) => ({
                    ...s,
                    messages: [
                      ...s.messages,
                      {
                        id: nextId(),
                        role: "system" as const,
                        content: result.value,
                        timestamp: Date.now(),
                      },
                    ],
                  }));
                  return;
                case "clear":
                  agentRef.current?.resetConversation();
                  store.setState((s) => ({
                    ...s,
                    messages: [],
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                  }));
                  return;
                case "skip":
                  return;
              }
              return;
            }

            case "prompt": {
              const prompt = await matched.getPrompt(parsed.args, ctx);
              await runAgent(prompt, input);
              return;
            }
          }
        }

        store.setState((s) => ({
          ...s,
          messages: [
            ...s.messages,
            {
              id: nextId(),
              role: "system" as const,
              content: `Unknown command: /${parsed.name}. Type /help to see available commands.`,
              timestamp: Date.now(),
              isError: true,
            },
          ],
        }));
        return;
      }

      await runAgent(input);
    },
    [store, buildCommandCtx, runAgent],
  );

  const handleHistoryChange = useCallback(
    (index: number) => {
      store.setState((s) => ({ ...s, historyIndex: index }));
    },
    [store],
  );

  const isProcessing = state.status !== "idle" && state.status !== "error";

  // ─── Ctrl+C: double-press to abort agent / exit app ────────────────
  const lastCtrlCRef = useRef<number>(0);

  const handleCtrlC = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastCtrlCRef.current;
    lastCtrlCRef.current = now;

    const processing = store.getState().status !== "idle" && store.getState().status !== "error";

    if (processing) {
      if (elapsed < 1500) {
        agentRef.current?.abort();
        store.setState((s) => ({
          ...s,
          status: "idle",
          messages: [
            ...s.messages,
            { id: nextId(), role: "system" as const, content: "Agent interrupted.", timestamp: Date.now() },
          ],
        }));
      } else {
        agentRef.current?.abort();
        store.setState((s) => ({
          ...s,
          messages: [
            ...s.messages,
            { id: nextId(), role: "system" as const, content: "Interrupting... press Ctrl+C again to force stop.", timestamp: Date.now() },
          ],
        }));
      }
    } else {
      if (elapsed < 1500) {
        exit();
      } else {
        store.setState((s) => ({
          ...s,
          messages: [
            ...s.messages,
            { id: nextId(), role: "system" as const, content: "Press Ctrl+C again to exit.", timestamp: Date.now() },
          ],
        }));
      }
    }
  }, [store, exit]);

  // Ink captures Ctrl+C as raw input in raw mode — catch it via useInput
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      handleCtrlC();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      {state.messages.length === 0 && <Logo provider={state.provider} />}

      <MessageList messages={state.messages} isStreaming={isProcessing} />

      {state.showPermission && (
        <PermissionDialog
          request={{
            ...state.showPermission,
            resolve: (allowed) => {
              state.showPermission!.resolve(allowed);
              store.setState((s) => ({ ...s, showPermission: null }));
            },
          }}
        />
      )}

      <InputBox
        onSubmit={handleSubmit}
        disabled={isProcessing || !!state.showPermission}
        history={state.inputHistory}
        historyIndex={state.historyIndex}
        onHistoryChange={handleHistoryChange}
      />

      <StatusBar state={state} />
    </Box>
  );
}
