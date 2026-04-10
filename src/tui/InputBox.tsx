/**
 * InputBox — user input with history navigation and slash command autocomplete.
 */
import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface InputBoxProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  history: string[];
  historyIndex: number;
  onHistoryChange: (index: number) => void;
}

export function InputBox({
  onSubmit,
  disabled,
  history,
  historyIndex,
  onHistoryChange,
}: InputBoxProps): React.ReactElement {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setValue("");
      onSubmit(trimmed);
    },
    [onSubmit],
  );

  useInput(
    (input, key) => {
      if (disabled) return;
      // History navigation
      if (key.upArrow && history.length > 0) {
        const newIdx = Math.min(historyIndex + 1, history.length - 1);
        onHistoryChange(newIdx);
        setValue(history[history.length - 1 - newIdx] ?? "");
      }
      if (key.downArrow) {
        if (historyIndex > 0) {
          const newIdx = historyIndex - 1;
          onHistoryChange(newIdx);
          setValue(history[history.length - 1 - newIdx] ?? "");
        } else {
          onHistoryChange(-1);
          setValue("");
        }
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box paddingX={1}>
      <Text color={disabled ? "gray" : "blue"} bold>
        {"❯ "}
      </Text>
      {disabled ? (
        <Text dimColor>Processing...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Type your message... (/help for commands)"
        />
      )}
    </Box>
  );
}
