#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"; CONFIG_FILE="$7"

THRESHOLD=$(get_config "$CONFIG_FILE" "undo_pct" "80")

RESULT=$(get_undo_usage "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$THRESHOLD")

if [[ -z "$RESULT" || "$RESULT" =~ "^[[:space:]]*$" ]]; then
    STATUS="OK"
    MESSAGE="UNDO usage below ${THRESHOLD}%"
    NEED_FIX="false"
    DETAILS="[]"
else
    STATUS="WARNING"
    NEED_FIX="true"
    
    DETAILS=$(echo "$RESULT" | while read line; do
        [[ -z "$line" ]] && continue
        TBS=$(echo "$line" | cut -d'|' -f1)
        PCT=$(echo "$line" | cut -d'|' -f2)
        echo "{\"tablespace\":\"$TBS\",\"used_pct\":$PCT}"
    done | jq -s .)
    
    MESSAGE="UNDO tablespace above ${THRESHOLD}%"
fi

format_json_result "03" "undo" "$STATUS" "$MESSAGE" "$DETAILS" "$NEED_FIX" "fix_undo_extend.sh" > "$STATE_DIR/03_undo.json"
