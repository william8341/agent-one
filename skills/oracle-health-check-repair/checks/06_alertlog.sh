#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"; CONFIG_FILE="$7"
SSH_USER="$8"; SSH_KEY="$9"; SSH_PASS="${10}"

HOURS=$(get_config "$CONFIG_FILE" "alertlog_hours" "24")
LINES=$(get_config "$CONFIG_FILE" "alertlog_lines" "100")

if [[ -n "$SSH_USER" ]]; then
    RESULT=$(get_alert_errors_ssh "$HOST" "$SID" "$SSH_USER" "$SSH_KEY" "$LINES" "$SSH_PASS")
else
    RESULT=$(get_alert_errors "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$HOURS")
fi

if [[ -z "$RESULT" || "$RESULT" =~ "^[[:space:]]*$" ]]; then
    STATUS="OK"
    MESSAGE="No ORA- errors in alert log"
    NEED_FIX="false"
    DETAILS="[]"
else
    STATUS="WARNING"
    NEED_FIX="false"
    
    DETAILS=$(echo "$RESULT" | head -10 | while read line; do
        [[ -z "$line" ]] && continue
        MSG=$(echo "$line" | jq -Rs .)
        echo "$MSG"
    done | jq -s .)
    
    COUNT=$(echo "$RESULT" | grep -v '^[[:space:]]*$' | wc -l)
    MESSAGE="$COUNT ORA- error(s) found in last ${HOURS}h"
fi

format_json_result "06" "alertlog" "$STATUS" "$MESSAGE" "$DETAILS" "$NEED_FIX" "" > "$STATE_DIR/06_alertlog.json"
