#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"

STATE_FILE="$STATE_DIR/03_undo.json"

if [[ ! -f "$STATE_FILE" ]]; then
    format_fix_result "fix_undo_extend.sh" "SKIPPED" "No state file found"
    exit 0
fi

TBS_NAME=$(cat "$STATE_FILE" | jq -r '.details[0].tablespace // empty')

if [[ -z "$TBS_NAME" || "$TBS_NAME" == "null" ]]; then
    format_fix_result "fix_undo_extend.sh" "SKIPPED" "No UNDO tablespace to fix"
    exit 0
fi

FILE_NAME=$(run_sql "$USER" "$PASS" "$HOST" "$PORT" "$SID" "SELECT file_name FROM dba_data_files WHERE tablespace_name='$TBS_NAME' AND ROWNUM=1" | tr -d ' ')

if [[ -z "$FILE_NAME" ]]; then
    format_fix_result "fix_undo_extend.sh" "ERROR" "Could not get datafile name"
    exit 1
fi

CURRENT_SIZE=$(run_sql "$USER" "$PASS" "$HOST" "$PORT" "$SID" "SELECT bytes/1024/1024 FROM dba_data_files WHERE file_name='$FILE_NAME'" | tr -d ' ')
NEW_SIZE=$((CURRENT_SIZE + 5120))

OUTPUT=$(run_sql_with_header "$USER" "$PASS" "$HOST" "$PORT" "$SID" "ALTER DATABASE DATAFILE '$FILE_NAME' RESIZE ${NEW_SIZE}M" 2>&1)

if [[ $? -eq 0 ]]; then
    format_fix_result "fix_undo_extend.sh" "SUCCESS" "Extended UNDO from ${CURRENT_SIZE}M to ${NEW_SIZE}M" > "$STATE_DIR/fix_03_undo.json"
else
    format_fix_result "fix_undo_extend.sh" "ERROR" "Failed to extend: $OUTPUT" > "$STATE_DIR/fix_03_undo.json"
fi
