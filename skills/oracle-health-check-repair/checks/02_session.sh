#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"; CONFIG_FILE="$7"

WAIT_SECONDS=$(get_config "$CONFIG_FILE" "lock_wait_seconds" "300")

RESULT=$(get_blocking_sessions "$USER" "$PASS" "$HOST" "$PORT" "$SID")

if [[ -z "$RESULT" || "$RESULT" =~ "^[[:space:]]*$" ]]; then
    STATUS="OK"
    MESSAGE="No blocking sessions found"
    NEED_FIX="false"
    DETAILS="[]"
else
    STATUS="WARNING"
    NEED_FIX="true"
    
    DETAILS=$(echo "$RESULT" | while read line; do
        [[ -z "$line" ]] && continue
        BLOCKER=$(echo "$line" | cut -d'|' -f1)
        SERIAL=$(echo "$line" | cut -d'|' -f2)
        USER=$(echo "$line" | cut -d'|' -f3)
        echo "{\"blocker\":\"$BLOCKER\",\"serial\":$SERIAL,\"username\":\"$USER\",\"wait_seconds\":0}"
    done | jq -s 'unique_by(.blocker)')
    
    BLOCKER_COUNT=$(echo "$RESULT" | grep -v '^[[:space:]]*$' | cut -d'|' -f1 | sort -u | wc -l)
    MESSAGE="$BLOCKER_COUNT blocking session(s) found"
fi

format_json_result "02" "session" "$STATUS" "$MESSAGE" "$DETAILS" "$NEED_FIX" "fix_kill_session.sh" > "$STATE_DIR/02_session.json"
