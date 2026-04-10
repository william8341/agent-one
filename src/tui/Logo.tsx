/**
 * Logo component — startup banner with version and model info.
 */
import React from "react";
import { Box, Text } from "ink";
import type { ProviderConfig } from "../types.js";

interface LogoProps {
  provider: ProviderConfig;
}

const LOGO = `
   _                    _      ___
  /_\\  __ _ ___ _ _  | |_   / _ \\ _ _  ___
 / _ \\/ _\` / -_) ' \\ |  _| | (_) | ' \\/ -_)
/_/ \\_\\__, \\___|_||_|  \\__|  \\___/|_||_\\___|
      |___/
`;

export function Logo({ provider }: LogoProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>{LOGO.trimEnd()}</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Model: <Text color="green" bold>{provider.model}</Text>
          {" "}({provider.type})
          {"  "}|{"  "}Type <Text color="yellow">/help</Text> for commands
          {"  "}|{"  "}Press <Text color="yellow">Ctrl+C</Text> to exit
        </Text>
      </Box>
      <Box marginTop={0}>
        <Text dimColor>{"─".repeat(70)}</Text>
      </Box>
    </Box>
  );
}
