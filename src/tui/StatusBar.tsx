/**
 * StatusBar — shows model, status, token usage at the bottom.
 */
import React from "react";
import { Box, Text } from "ink";
import type { AppState } from "../types.js";

interface StatusBarProps {
  state: AppState;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "green",
  thinking: "yellow",
  streaming: "cyan",
  tool_running: "magenta",
  error: "red",
};

const STATUS_ICONS: Record<string, string> = {
  idle: "●",
  thinking: "◐",
  streaming: "▸",
  tool_running: "⚙",
  error: "✗",
};

export function StatusBar({ state }: StatusBarProps): React.ReactElement {
  const color = STATUS_COLORS[state.status] ?? "white";
  const icon = STATUS_ICONS[state.status] ?? "?";
  const { usage, provider } = state;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
      width="100%"
    >
      <Box gap={2}>
        <Text color={color} bold>
          {icon} {state.status.toUpperCase()}
        </Text>
        <Text dimColor>|</Text>
        <Text color="cyan">{provider.model}</Text>
        <Text dimColor>({provider.type})</Text>
      </Box>
      <Box gap={2}>
        <Text dimColor>
          tokens: {usage.totalTokens.toLocaleString()}
        </Text>
        {state.errorMessage && (
          <>
            <Text dimColor>|</Text>
            <Text color="red">{state.errorMessage}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
