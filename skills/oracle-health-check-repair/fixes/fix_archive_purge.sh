#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"

STATE_FILE="$STATE_DIR/04_archive.json"

if [[ ! -f "$STATE_FILE" ]]; then
    format_fix_result "fix_archive_purge.sh" "SKIPPED" "No state file found"
    exit 0
fi

OUTPUT=$(run_sql_with_header "$USER" "$PASS" "$HOST" "$PORT" "$SID" "DELETE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-1';" 2>&1)

if [[ $? -eq 0 ]]; then
    format_fix_result "fix_archive_purge.sh" "SUCCESS" "Purged old archivelogs" > "$STATE_DIR/fix_04_archive.json"
else
    format_fix_result "fix_archive_purge.sh" "ERROR" "Failed to purge: $OUTPUT" > "$STATE_DIR/fix_04_archive.json"
fi
