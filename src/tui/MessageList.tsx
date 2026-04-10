/**
 * MessageList — renders conversation messages with role-based styling.
 * Messages from sub-agents are indented by depth level with a left border.
 */
import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { UIMessage } from "../types.js";

interface MessageListProps {
  messages: UIMessage[];
  isStreaming: boolean;
}

export function MessageList({
  messages,
  isStreaming,
}: MessageListProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg) => (
        <MessageItem key={msg.id} message={msg} />
      ))}
      {isStreaming && messages.length > 0 && !messages[messages.length - 1]?.isStreaming && (
        <Box marginTop={0}>
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Thinking...</Text>
        </Box>
      )}
    </Box>
  );
}

/** Depth colors for the nesting indicator bar */
const DEPTH_COLORS = ["magenta", "cyan", "yellow", "blue", "green"] as const;

function MessageItem({ message }: { message: UIMessage }): React.ReactElement {
  const depth = message.depth ?? 0;

  // Wrap with indentation for sub-agent messages
  if (depth > 0) {
    return (
      <Box marginY={0} flexDirection="row">
        {/* Render depth indicator bars */}
        {Array.from({ length: depth }).map((_, i) => (
          <Text key={i} color={DEPTH_COLORS[i % DEPTH_COLORS.length]}>{"│ "}</Text>
        ))}
        <Box flexDirection="column" flexGrow={1}>
          <MessageContent message={message} />
        </Box>
      </Box>
    );
  }

  return <MessageContent message={message} />;
}

function MessageContent({ message }: { message: UIMessage }): React.ReactElement {
  const { role, content, toolName, toolArgs, isError, depth } = message;
  const d = depth ?? 0;

  if (role === "user") {
    return (
      <Box marginY={0}>
        <Text color="blue" bold>{"❯ "}</Text>
        <Text color="white" bold>{content}</Text>
      </Box>
    );
  }

  if (role === "tool") {
    // Tool call header (no result yet)
    if (toolArgs !== undefined && !content) {
      return (
        <Box marginY={0}>
          <Text color="magenta">{"⚙ "}</Text>
          <Text color="magenta" bold>{toolName ?? "tool"}</Text>
          {toolArgs ? <Text dimColor>{" "}({toolArgs})</Text> : null}
        </Box>
      );
    }

    // Tool result
    const isSkill = toolName === "use_skill";
    const color = isError ? "red" : isSkill ? "cyan" : "gray";
    const icon = isError ? "✗" : "✓";
    const limit = isSkill ? 2000 : 500;
    const truncated =
      content.length > limit ? content.slice(0, limit) + "\n... (truncated)" : content;
    return (
      <Box marginY={0} flexDirection="column">
        <Box>
          <Text color="magenta">{"⚙ "}</Text>
          <Text color="magenta" bold>{toolName ?? "tool"}</Text>
          {toolArgs ? <Text dimColor>{" "}({toolArgs})</Text> : null}
        </Box>
        <Box paddingLeft={2}>
          <Text color={color}>
            {icon} {truncated}
          </Text>
        </Box>
      </Box>
    );
  }

  if (role === "assistant") {
    const prefix = d > 0 ? "◇ " : "◆ ";
    const color = d > 0 ? "cyan" : "green";
    return (
      <Box marginY={0}>
        <Text color={color} bold>{prefix}</Text>
        <Text>{content}</Text>
        {message.isStreaming && <Text color="cyan">▌</Text>}
      </Box>
    );
  }

  // system messages
  return (
    <Box marginY={0}>
      <Text dimColor italic>{content}</Text>
    </Box>
  );
}
