/**
 * App — root TUI component. Composes Logo, MessageList, InputBox, StatusBar,
 * PermissionDialog. Drives the Agent streaming loop.
 *
 * Command dispatch by type:
 *   local     → execute locally, display result text. No agent loop.
 *   prompt    → expand to prompt string, feed into agent.runStreaming().
 *   local-jsx → (reserved) same as local for now.
 */
import React, { useCallback, useEffect, useRef } from "react";
import { Box, useApp } from "ink";
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

  // Build agent on provider change
  useEffect(() => {
    const currentProvider = store.getState().provider;
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const llm = new LlmClient(currentProvider);
    const agent = new Agent(llm, registry, skills, { cwd });

    agent.onPermissionRequest = (toolName, args) => {
      return new Promise<boolean>((resolve) => {
        store.setState((s) => ({
          ...s,
          showPermission: { toolName, args, resolve } as PermissionRequest,
        }));
      });
    };

    agentRef.current = agent;
  }, [state.provider, skills, cwd, store]);

  // ─── Build command context (shared by all command types) ──────────────
  const buildCommandCtx = useCallback((): CommandContext => ({
    setState: (fn) => store.setState(fn),
    getState: () => store.getState(),
    customModels,
    cwd,
    skills,
  }), [store, customModels, cwd, skills]);

  // ─── Run agent streaming loop (reusable for both natural lang & prompt commands)
  const runAgent = useCallback(
    async (prompt: string, displayAsUser?: string) => {
      // Show what the user typed (or the command name) as user message
      const userContent = displayAsUser ?? prompt;
      const userMsg: UIMessage = {
        id: nextId(),
        role: "user",
        content: userContent,
        timestamp: Date.now(),
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
              store.setState((s) => ({ ...s, status: "tool_running" }));
              break;
            }
            case "tool_result": {
              const toolMsg: UIMessage = {
                id: nextId(),
                role: "tool",
                content: event.result.content,
                toolName: event.toolName,
                timestamp: Date.now(),
                isError: !event.result.ok,
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
                    role: "system",
                    content: `Error: ${event.error}`,
                    timestamp: Date.now(),
                    isError: true,
                  } as UIMessage,
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
              role: "system",
              content: `Error: ${String(error)}`,
              timestamp: Date.now(),
              isError: true,
            } as UIMessage,
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
      // Save to history
      store.setState((s) => ({
        ...s,
        inputHistory: [...s.inputHistory, input],
        historyIndex: -1,
        errorMessage: null,
      }));

      // ── Slash command dispatch ──────────────────────────────────────
      const parsed = parseSlashCommand(input);
      if (parsed) {
        const commands = createBuiltinCommands();
        const matched = findCommand(parsed.name, commands);

        if (matched) {
          const ctx = buildCommandCtx();

          switch (matched.type) {
            // ─── LOCAL: execute locally, no agent loop ────────────────
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

            // ─── PROMPT: expand to prompt, send to agent loop ─────────
            case "prompt": {
              const prompt = await matched.getPrompt(parsed.args, ctx);
              await runAgent(prompt, input);
              return;
            }
          }
        }

        // Unknown slash command — show as error
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

      // ── Natural language input → agent loop ────────────────────────
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
