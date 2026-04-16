#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"; CONFIG_FILE="$7"

THRESHOLD=$(get_config "$CONFIG_FILE" "processes_pct" "90")

RESULT=$(get_processes_usage "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$THRESHOLD")

if [[ -z "$RESULT" || "$RESULT" =~ "^[[:space:]]*$" || "$RESULT" == "null" ]]; then
    STATUS="OK"
    MESSAGE="PROCESSES usage normal"
    NEED_FIX="false"
    DETAILS="[]"
    RESULT="0"
else
    PCT=$(echo "$RESULT" | tr -d ' ')
    if (( $(echo "$PCT > $THRESHOLD" | bc -l 2>/dev/null || echo "0") )); then
        STATUS="WARNING"
        NEED_FIX="true"
        DETAILS="[{\"resource\":\"processes\",\"used_pct\":$PCT}]"
        MESSAGE="PROCESSES at ${PCT}%"
    else
        STATUS="OK"
        NEED_FIX="false"
        DETAILS="[{\"resource\":\"processes\",\"used_pct\":$PCT}]"
        MESSAGE="PROCESSES at ${PCT}%"
    fi
fi

format_json_result "07" "resource_limit" "$STATUS" "$MESSAGE" "$DETAILS" "$NEED_FIX" "fix_process_limit.sh" > "$STATE_DIR/07_resource_limit.json"
