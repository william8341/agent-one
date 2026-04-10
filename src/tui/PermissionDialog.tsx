/**
 * PermissionDialog — asks user to allow/deny tool execution.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../types.js";

interface PermissionDialogProps {
  request: PermissionRequest;
}

export function PermissionDialog({
  request,
}: PermissionDialogProps): React.ReactElement {
  useInput((input) => {
    if (input === "y" || input === "Y") {
      request.resolve(true);
    } else if (input === "n" || input === "N") {
      request.resolve(false);
    }
  });

  const argsStr =
    typeof request.args === "string"
      ? request.args
      : JSON.stringify(request.args, null, 2);

  const truncated =
    argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
    >
      <Text color="yellow" bold>
        ⚠ Permission Required
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Tool: <Text color="cyan" bold>{request.toolName}</Text>
        </Text>
        <Box marginTop={0}>
          <Text dimColor>Args: {truncated}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text>
          Allow? <Text color="green" bold>[Y]es</Text> / <Text color="red" bold>[N]o</Text>
        </Text>
      </Box>
    </Box>
  );
}
