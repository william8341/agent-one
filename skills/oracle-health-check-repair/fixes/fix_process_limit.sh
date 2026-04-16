#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"

STATE_FILE="$STATE_DIR/07_resource_limit.json"

if [[ ! -f "$STATE_FILE" ]]; then
    format_fix_result "fix_process_limit.sh" "SKIPPED" "No state file found"
    exit 0
fi

CURRENT_LIMIT=$(run_sql "$USER" "$PASS" "$HOST" "$PORT" "$SID" "SELECT limit_value FROM v\$resource_limit WHERE resource_name='processes'" | tr -d ' ')

if [[ -z "$CURRENT_LIMIT" || "$CURRENT_LIMIT" == "null" ]]; then
    format_fix_result "fix_process_limit.sh" "ERROR" "Could not get current limit"
    exit 1
fi

NEW_LIMIT=$((CURRENT_LIMIT + 100))

OUTPUT=$(run_sql_with_header "$USER" "$PASS" "$HOST" "$PORT" "$SID" "ALTER SYSTEM SET processes=$NEW_LIMIT SCOPE=SPFILE" 2>&1)

if [[ $? -eq 0 ]]; then
    format_fix_result "fix_process_limit.sh" "SUCCESS" "Increased processes from $CURRENT_LIMIT to $NEW_LIMIT (requires restart)" > "$STATE_DIR/fix_07_resource_limit.json"
else
    format_fix_result "fix_process_limit.sh" "ERROR" "Failed to update: $OUTPUT" > "$STATE_DIR/fix_07_resource_limit.json"
fi
