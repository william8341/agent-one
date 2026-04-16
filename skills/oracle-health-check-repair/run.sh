#!/usr/bin/env bash

set -euo pipefail

ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
export ORACLE_HOME
export PATH="$ORACLE_HOME:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR"
CONFIG_DIR="$SKILL_DIR/config"
LIB_DIR="$SKILL_DIR/lib"
CHECKS_DIR="$SKILL_DIR/checks"
FIXES_DIR="$SKILL_DIR/fixes"
OUTPUT_DIR="$SKILL_DIR/output"

HOST=""
PORT="1521"
USER=""
PASS=""
SID=""
KEYCHAIN=""
SSH_USER=""
SSH_KEY=""
SSH_PASS=""
AUTO_FIX=true
DB_NAME=""
ORACLE_DB_SCRIPT="$HOME/.opencode/skills/oracle-db/scripts/oracle_db.py"
USE_QUERY_USER=false

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

show_help() {
    cat << 'EOF'
Oracle Health Check + Auto-Repair

Usage: run.sh [OPTIONS]

Options:
  -H, --host HOST       Oracle host
  -P, --port PORT       Oracle port (default: 1521)
  -u, --user USER       Database user
  -p, --password PASS   Database password
  -s, --sid SID         Oracle SID
  -n, --db-name NAME    Database name in oracle-db inventory
  -k, --keychain NAME   Mac Keychain item (format: user@host:sid)
  --oracle-home PATH    Oracle Instant Client path
  --ssh-user USER       SSH user for remote adrci execution
  --ssh-key PATH        SSH private key for remote execution
  --ssh-pass PASS       SSH password for remote execution
  --query-user          Use query user instead of SYSDBA
  --no-fix              Run checks only, no auto-fix
  -h, --help            Show this help

Examples:
  ./run.sh -H 192.168.1.100 -u system -p password -s orcl
  ./run.sh -n orcldg
  ./run.sh -n orcldg --query-user
  ./run.sh -n orcldg --query-user --no-fix
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -H|--host) HOST="$2"; shift 2 ;;
            -P|--port) PORT="$2"; shift 2 ;;
            -u|--user) USER="$2"; shift 2 ;;
            -p|--password) PASS="$2"; shift 2 ;;
            -s|--sid) SID="$2"; shift 2 ;;
            -n|--db-name) DB_NAME="$2"; shift 2 ;;
            -k|--keychain) KEYCHAIN="$2"; shift 2 ;;
            --oracle-home) ORACLE_HOME="$2"; shift 2 ;;
            --ssh-user) SSH_USER="$2"; shift 2 ;;
            --ssh-key) SSH_KEY="$2"; shift 2 ;;
            --ssh-pass) SSH_PASS="$2"; shift 2 ;;
            --query-user) USE_QUERY_USER=true; shift ;;
            --no-fix) AUTO_FIX=false; shift ;;
            -h|--help) show_help; exit 0 ;;
            *) echo "Unknown: $1"; show_help; exit 1 ;;
        esac
    done
}

if [[ $# -eq 0 ]]; then
    show_help
    exit 0
fi

parse_args "$@"

if [[ -n "$KEYCHAIN" ]]; then
    PASS=$(get_keychain_password "$KEYCHAIN")
    if [[ -z "$PASS" ]]; then
        error "Keychain password not found for: $KEYCHAIN"
        exit 1
    fi
    USER=$(echo "$KEYCHAIN" | cut -d'@' -f1)
    HOST=$(echo "$KEYCHAIN" | cut -d'@' -f2 | cut -d':' -f1)
    SID=$(echo "$KEYCHAIN" | cut -d':' -f2)
fi

load_from_oracle_db() {
    local db_name="$1"
    if [[ ! -f "$ORACLE_DB_SCRIPT" ]]; then
        error "oracle-db script not found: $ORACLE_DB_SCRIPT"
        return 1
    fi
    
    local conn_info
    conn_info=$(python3 "$ORACLE_DB_SCRIPT" query --name "$db_name" 2>/dev/null)
    if [[ $? -ne 0 || -z "$conn_info" ]]; then
        error "Database not found in oracle-db: $db_name"
        return 1
    fi
    
    HOST=$(echo "$conn_info" | grep "地址:" | sed 's/.*地址: *//' | cut -d: -f1)
    PORT=$(echo "$conn_info" | grep "地址:" | sed 's/.*地址: *//' | cut -d: -f2)
    SID=$(echo "$conn_info" | grep "SID:" | sed 's/.*SID: *//')
    
    if [[ "$USE_QUERY_USER" == "true" ]]; then
        PASS=$(python3 -c "
import sys
sys.path.insert(0, '$HOME/.opencode/skills/oracle-db/scripts')
from oracle_db import get
info = get('$db_name', 'query')
print(info.get('password',''))
" 2>/dev/null)
        
        USER=$(python3 -c "
import sys
sys.path.insert(0, '$HOME/.opencode/skills/oracle-db/scripts')
from oracle_db import get
info = get('$db_name', 'query')
print(info.get('user',''))
" 2>/dev/null)
        
        info "Using query user: $USER"
    else
        PASS=$(python3 -c "
import sys
sys.path.insert(0, '$HOME/.opencode/skills/oracle-db/scripts')
from oracle_db import get
info = get('$db_name', 'sysdba')
print(info.get('password',''))
" 2>/dev/null)
        
        USER="sys"
    fi
    
    if [[ -z "$HOST" || -z "$SID" || -z "$PASS" || -z "$USER" ]]; then
        error "Failed to load connection info from oracle-db"
        return 1
    fi
    
    info "Loaded from oracle-db: $db_name -> $HOST/$SID"
    return 0
}

if [[ -n "$DB_NAME" ]]; then
    if ! load_from_oracle_db "$DB_NAME"; then
        exit 1
    fi
fi

if [[ -z "$HOST" || -z "$USER" || -z "$PASS" || -z "$SID" ]]; then
    error "Missing required parameters"
    show_help
    exit 1
fi

LOCK_FILE="/tmp/oracle_health_check_${SID}.lock"
STATE_DIR=$(mktemp -d)
CONFIG_FILE="$CONFIG_DIR/thresholds.conf"

mkdir -p "$OUTPUT_DIR"

if ! create_lock "$LOCK_FILE"; then
    error "Another instance is running for SID: $SID"
    exit 1
fi

trap 'rm -rf "$STATE_DIR" "$LOCK_FILE"' EXIT

info "Starting health check for $HOST/$SID"

if ! test_connection "$USER" "$PASS" "$HOST" "$PORT" "$SID"; then
    error "Cannot connect to database"
    exit 1
fi

INSTANCE_INFO=$(get_instance_info "$USER" "$PASS" "$HOST" "$PORT" "$SID")
DB_VERSION=$(echo "$INSTANCE_INFO" | cut -d'|' -f2)
DB_STATUS=$(echo "$INSTANCE_INFO" | cut -d'|' -f3)

info "Connected to $SID (v$DB_VERSION, $DB_STATUS)"

declare -a CHECK_RESULTS
declare -a FIX_RESULTS
OVERALL_STATUS="OK"
ISSUES_COUNT=0

for check_script in "$CHECKS_DIR"/[0-9]*.sh; do
    [[ ! -f "$check_script" ]] && continue
    
    CHECK_NAME=$(basename "$check_script" .sh)
    echo "Running: $CHECK_NAME"
    
    "$check_script" "$HOST" "$PORT" "$USER" "$PASS" "$SID" "$STATE_DIR" "$CONFIG_FILE" "$SSH_USER" "$SSH_KEY" "$SSH_PASS"
    
    CHECK_ID=$(basename "$check_script" .sh)
    STATE_FILE="$STATE_DIR/${CHECK_ID}.json"
    
    if [[ -f "$STATE_FILE" ]]; then
        CHECK_STATUS=$(cat "$STATE_FILE" | jq -r '.status')
        NEED_FIX=$(cat "$STATE_FILE" | jq -r '.need_fix')
        FIX_SCRIPT=$(cat "$STATE_FILE" | jq -r '.fix_script // empty')
        
        if [[ "$CHECK_STATUS" == "WARNING" || "$CHECK_STATUS" == "CRITICAL" ]]; then
            OVERALL_STATUS="WARNING"
            ISSUES_COUNT=$((ISSUES_COUNT + 1))
        fi
        
        if [[ "$NEED_FIX" == "true" && "$AUTO_FIX" == "true" && -n "$FIX_SCRIPT" ]]; then
            FIX_PATH="$FIXES_DIR/$FIX_SCRIPT"
            if [[ -f "$FIX_PATH" ]]; then
                echo "Applying fix: $FIX_SCRIPT"
                "$FIX_PATH" "$HOST" "$PORT" "$USER" "$PASS" "$SID" "$STATE_DIR"
                
                FIX_STATE="$STATE_DIR/fix_${CHECK_ID}.json"
                if [[ -f "$FIX_STATE" ]]; then
                    FIX_RESULTS+=("$(cat "$FIX_STATE")")
                fi
            fi
        fi
        
        CHECK_RESULTS+=("$(cat "$STATE_FILE")")
    fi
done

CHECKS_JSON=$(printf '%s\n' "${CHECK_RESULTS[@]:-}" | jq -s .)
FIXES_JSON=$(printf '%s\n' "${FIX_RESULTS[@]:-}" | jq -s .)

FINAL_RESULT=$(jq -n \
    --arg check_time "$(get_json_timestamp)" \
    --arg host "$HOST" \
    --arg port "$PORT" \
    --arg user "$USER" \
    --arg sid "$SID" \
    --arg version "$DB_VERSION" \
    --arg status "$DB_STATUS" \
    --arg overall_status "$OVERALL_STATUS" \
    --argjson issues "$ISSUES_COUNT" \
    --argjson checks "$CHECKS_JSON" \
    --argjson fixes "$FIXES_JSON" \
    '{
        check_time: $check_time,
        connection: {host: $host, port: $port, user: $user, sid: $sid, version: $version, status: $status},
        overall_status: $overall_status,
        issues_found: $issues,
        checks: $checks,
        fixes_applied: $fixes
    }')

JSON_OUTPUT="$OUTPUT_DIR/result_$(date +%Y%m%d_%H%M%S).json"
echo "$FINAL_RESULT" | jq . > "$JSON_OUTPUT"

MD_OUTPUT="$OUTPUT_DIR/result_$(date +%Y%m%d_%H%M%S).md"
generate_markdown_report "$FINAL_RESULT" "$MD_OUTPUT"

echo ""
echo "=== Result ==="
echo "Overall Status: $OVERALL_STATUS"
echo "Issues Found: $ISSUES_COUNT"
echo "JSON: $JSON_OUTPUT"
echo "Markdown: $MD_OUTPUT"

case "$OVERALL_STATUS" in
    "OK") exit 0 ;;
    "WARNING") exit 1 ;;
    "CRITICAL") exit 2 ;;
    *) exit 3 ;;
esac
