/**
 * MessageList — renders conversation messages with role-based styling.
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

function MessageItem({ message }: { message: UIMessage }): React.ReactElement {
  const { role, content, toolName, isError } = message;

  if (role === "user") {
    return (
      <Box marginY={0} flexDirection="column">
        <Box>
          <Text color="blue" bold>{"❯ "}</Text>
          <Text color="white" bold>{content}</Text>
        </Box>
      </Box>
    );
  }

  if (role === "tool") {
    const color = isError ? "red" : "gray";
    const icon = isError ? "✗" : "✓";
    const truncated =
      content.length > 500 ? content.slice(0, 500) + "\n... (truncated)" : content;
    return (
      <Box marginY={0} flexDirection="column">
        <Text color="magenta" dimColor>
          {"  "}⚙ {toolName ?? "tool"}
        </Text>
        <Box paddingLeft={4}>
          <Text color={color}>
            {icon} {truncated}
          </Text>
        </Box>
      </Box>
    );
  }

  if (role === "assistant") {
    return (
      <Box marginY={0} flexDirection="column">
        <Box>
          <Text color="green" bold>{"◆ "}</Text>
          <Text>{content}</Text>
          {message.isStreaming && (
            <Text color="cyan">▌</Text>
          )}
        </Box>
      </Box>
    );
  }

  // system messages
  return (
    <Box marginY={0}>
      <Text dimColor italic>{"  "}{content}</Text>
    </Box>
  );
}
