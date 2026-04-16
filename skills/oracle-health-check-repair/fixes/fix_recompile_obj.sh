#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"

STATE_FILE="$STATE_DIR/05_invalid_objects.json"

if [[ ! -f "$STATE_FILE" ]]; then
    format_fix_result "fix_recompile_obj.sh" "SKIPPED" "No state file found"
    exit 0
fi

OUTPUT=$(run_sql_with_header "$USER" "$PASS" "$HOST" "$PORT" "$SID" "@?/rdbms/admin/utlrp.sql" 2>&1)

if [[ $? -eq 0 ]]; then
    format_fix_result "fix_recompile_obj.sh" "SUCCESS" "Recompiled invalid objects" > "$STATE_DIR/fix_05_invalid_objects.json"
else
    format_fix_result "fix_recompile_obj.sh" "ERROR" "Failed to recompile: $OUTPUT" > "$STATE_DIR/fix_05_invalid_objects.json"
fi
