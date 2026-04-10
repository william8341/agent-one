/**
 * App — root TUI component. Composes Logo, MessageList, InputBox, StatusBar,
 * PermissionDialog. Drives the Agent streaming loop.
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
import { parseSlashCommand, createBuiltinCommands } from "../commands.js";
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

    // Permission callback
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

      // Check for slash commands
      const cmd = parseSlashCommand(input);
      if (cmd) {
        const commands = createBuiltinCommands();
        const matched = commands.find((c) => c.name === cmd.name);
        if (matched) {
          const commandCtx: CommandContext = {
            setState: (fn) => store.setState(fn),
            getState: () => store.getState(),
            providers: [],
            customModels,
          };
          const result = await matched.execute(cmd.args, commandCtx);
          if (result === null) {
            // /clear
            return;
          }
          if (result) {
            store.setState((s) => ({
              ...s,
              messages: [
                ...s.messages,
                {
                  id: nextId(),
                  role: "system",
                  content: result,
                  timestamp: Date.now(),
                } as UIMessage,
              ],
            }));
          }
          return;
        }
      }

      // Add user message
      const userMsg: UIMessage = {
        id: nextId(),
        role: "user",
        content: input,
        timestamp: Date.now(),
      };
      store.setState((s) => ({
        ...s,
        messages: [...s.messages, userMsg],
        status: "thinking",
      }));

      const agent = agentRef.current;
      if (!agent) return;

      // Streaming agent loop
      const assistantMsgId = nextId();
      let assistantText = "";

      try {
        for await (const event of agent.runStreaming(input)) {
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
              store.setState((s) => ({
                ...s,
                status: "tool_running",
              }));
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
              store.setState((s) => ({
                ...s,
                messages: [...s.messages, toolMsg],
              }));
              break;
            }
            case "usage": {
              store.setState((s) => ({
                ...s,
                usage: event.usage,
              }));
              break;
            }
            case "done": {
              // Finalize streaming message
              store.setState((s) => {
                const msgs = s.messages.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, isStreaming: false, content: assistantText || event.finalText }
                    : m,
                );
                // If no assistant message was created yet (empty stream), add one
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

      // Ensure idle on completion
      store.setState((s) =>
        s.status !== "idle" ? { ...s, status: "idle" } : s,
      );
    },
    [store],
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
      {/* Logo — only show when no messages */}
      {state.messages.length === 0 && <Logo provider={state.provider} />}

      {/* Message list */}
      <MessageList messages={state.messages} isStreaming={isProcessing} />

      {/* Permission dialog */}
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

      {/* Input box */}
      <InputBox
        onSubmit={handleSubmit}
        disabled={isProcessing || !!state.showPermission}
        history={state.inputHistory}
        historyIndex={state.historyIndex}
        onHistoryChange={handleHistoryChange}
      />

      {/* Status bar */}
      <StatusBar state={state} />
    </Box>
  );
}
