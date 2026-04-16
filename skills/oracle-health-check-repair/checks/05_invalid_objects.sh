#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"; CONFIG_FILE="$7"

THRESHOLD=$(get_config "$CONFIG_FILE" "invalid_object_count" "1")

RESULT=$(get_invalid_objects "$USER" "$PASS" "$HOST" "$PORT" "$SID")

if [[ -z "$RESULT" || "$RESULT" =~ "^[[:space:]]*$" ]]; then
    STATUS="OK"
    MESSAGE="No invalid objects found"
    NEED_FIX="false"
    DETAILS="[]"
else
    TOTAL=$(echo "$RESULT" | while read line; do
        [[ -z "$line" ]] && continue
        echo "$line" | cut -d'|' -f3
    done | paste -sd+ | bc)
    
    if [[ -n "$TOTAL" && "$TOTAL" -gt "$THRESHOLD" ]]; then
        STATUS="WARNING"
        NEED_FIX="true"
        
        DETAILS=$(echo "$RESULT" | while read line; do
            [[ -z "$line" ]] && continue
            OWNER=$(echo "$line" | cut -d'|' -f1)
            TYPE=$(echo "$line" | cut -d'|' -f2)
            CNT=$(echo "$line" | cut -d'|' -f3)
            echo "{\"owner\":\"$OWNER\",\"object_type\":\"$TYPE\",\"count\":$CNT}"
        done | jq -s .)
        
        MESSAGE="$TOTAL invalid object(s) found"
    else
        STATUS="OK"
        NEED_FIX="false"
        DETAILS="[]"
        MESSAGE="$TOTAL invalid object(s) found"
    fi
fi

format_json_result "05" "invalid_objects" "$STATUS" "$MESSAGE" "$DETAILS" "$NEED_FIX" "fix_recompile_obj.sh" > "$STATE_DIR/05_invalid_objects.json"
