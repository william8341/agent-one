#!/usr/bin/env bash

set -euo pipefail

ORACLE_HOME="${ORACLE_HOME:-/Users/shangweilie/downloads/instantclient_23_3}"
export ORACLE_HOME
export PATH="$ORACLE_HOME:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR"
LIB_DIR="$SKILL_DIR/lib"
OUTPUT_DIR="$SKILL_DIR/output"

HOST=""
PORT="1521"
USER=""
PASS=""
SID=""
SSH_USER=""
SSH_KEY=""
SSH_PASS=""
OPERATION_TYPE="switchover"
CHECK_ONLY=false
AUTO_EXEC=false
USE_ORACLE_DB=""

source "$LIB_DIR/common.sh"
source "$LIB_DIR/adg.sh"
source "$LIB_DIR/formatter.sh"

show_help() {
    cat << 'EOF'
Oracle ADG Switch Tool

Usage: run.sh [OPTIONS]

Options:
  -H, --host HOST       Primary database host
  -P, --port PORT       Oracle port (default: 1521)
  -u, --user USER       Database user (needs DBA privileges)
  -p, --password PASS   Database password
  -s, --sid SID         Oracle SID
  -n, --db-name NAME    Use oracle-db asset (get credentials from asset)
  --ssh-user USER       OS user for SSH (required for switchover)
  --ssh-pass PASS       OS password for SSH
  --ssh-key PATH        SSH private key
  -t, --type TYPE       Operation type: switchover|failover (default: switchover)
  --check-only          Only check prerequisites, do not execute
  --auto                Auto execute without confirmation
  --oracle-home PATH    Oracle Instant Client path
  -h, --help            Show this help

Examples:
  ./run.sh -n orcldg
  ./run.sh -n orcldg --check-only
  ./run.sh -H 192.168.1.100 -u system -p password -s orclm --ssh-user oracle --ssh-pass "mypassword"
  ./run.sh -H 192.168.1.100 -u system -p password -s orclm --check-only
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
            -n|--db-name) USE_ORACLE_DB="$2"; shift 2 ;;
            --ssh-user) SSH_USER="$2"; shift 2 ;;
            --ssh-pass) SSH_PASS="$2"; shift 2 ;;
            --ssh-key) SSH_KEY="$2"; shift 2 ;;
            -t|--type) OPERATION_TYPE="$2"; shift 2 ;;
            --check-only) CHECK_ONLY=true; shift ;;
            --auto) AUTO_EXEC=true; shift ;;
            --oracle-home) ORACLE_HOME="$2"; shift 2 ;;
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

if [[ -n "$USE_ORACLE_DB" ]]; then
    ORACLE_DB_SCRIPT="${HOME}/.opencode/skills/oracle-db/scripts/oracle_db.py"
    if [[ ! -f "$ORACLE_DB_SCRIPT" ]]; then
        log_error "oracle-db script not found: $ORACLE_DB_SCRIPT"
        exit 1
    fi
    
    query_cred=$(python3 "$ORACLE_DB_SCRIPT" query --name "$USE_ORACLE_DB" --json --decrypt 2>/dev/null)
    if [[ $? -ne 0 || -z "$query_cred" ]]; then
        log_error "Cannot find oracle-db asset: $USE_ORACLE_DB"
        exit 1
    fi
    
    HOST=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ip',''))")
    PORT=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('port',1521))")
    SID=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sid',''))")
    USER=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sysdba_user','sys'))")
    PASS=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sysdba_user_password',''))")
    
    SSH_USER=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('os_user',''))")
    SSH_PASS=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('os_password',''))")
    SSH_PORT=$(echo "$query_cred" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('os_ssh_port',22))")
    
    log_info "Loaded credentials from oracle-db: $USE_ORACLE_DB ($HOST/$SID)"
fi

if [[ -z "$HOST" || -z "$USER" || -z "$PASS" || -z "$SID" ]]; then
    log_error "Missing required parameters"
    show_help
    exit 1
fi

if [[ "$OPERATION_TYPE" != "switchover" && "$OPERATION_TYPE" != "failover" ]]; then
    log_error "Invalid operation type: $OPERATION_TYPE"
    show_help
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/adg_switch_$(date +%Y%m%d_%H%M%S)"

log_info "Starting ADG $OPERATION_TYPE for $HOST/$SID"

if ! test_connection "$USER" "$PASS" "$HOST" "$PORT" "$SID"; then
    log_error "Cannot connect to database"
    exit 1
fi

log_info "Connected to $SID"
log_info "Getting current database role..."

current_role=$(check_current_role "$USER" "$PASS" "$HOST" "$PORT" "$SID")
log_info "Current database role: $current_role"

steps=""

log_info "Step 1: Checking current role"
step1_result=$(format_step_json "check_role" "OK" "Current role: $current_role")
steps=$(echo "$steps" | jq -s ".")

if [[ "$current_role" != "PRIMARY" && "$current_role" != "STANDBY" ]]; then
    log_error "Database is not in PRIMARY or STANDBY role"
    final_json=$(format_result_json "$OPERATION_TYPE" "ERROR" "$current_role" "$current_role" "[]" "Database role is $current_role")
    echo "$final_json" > "${OUTPUT_FILE}.json"
    exit 1
fi

log_info "Step 2: Checking prerequisites"
prereq_json=$(check_prerequisites_switchover "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$SSH_USER" "$SSH_KEY" "$SSH_PASS")
prereq_status=$(echo "$prereq_json" | jq -r '.arch_mode')
log_info "Archive mode: $prereq_status"

if [[ "$prereq_status" != "ARCHIVELOG" ]]; then
    log_warning "Database is not in ARCHIVELOG mode"
fi

step2_result=$(format_step_json "check_prerequisites" "OK" "$prereq_json")
steps="[$step1_result, $step2_result]"

if [[ "$CHECK_ONLY" == "true" ]]; then
    log_info "Check-only mode: prerequisites checked"
    final_json=$(format_result_json "$OPERATION_TYPE" "CHECKED" "$current_role" "$current_role" "$steps" "Prerequisites checked, ready to execute")
    echo "$final_json" | jq .
    echo "$final_json" > "${OUTPUT_FILE}.json"
    exit 0
fi

if [[ "$AUTO_EXEC" == "false" ]]; then
    log_warning "Auto-execute is disabled. Use --auto to execute automatically."
    log_warning "Or manually run after confirmation."
    final_json=$(format_result_json "$OPERATION_TYPE" "READY" "$current_role" "$current_role" "$steps" "Ready to execute, use --auto to proceed")
    echo "$final_json" | jq .
    echo "$final_json" > "${OUTPUT_FILE}.json"
    exit 0
fi

log_info "Step 3: Executing $OPERATION_TYPE"
log_warning "This will $OPERATION_TYPE the database. Press Ctrl+C to cancel in 10 seconds..."

sleep 5

if [[ "$OPERATION_TYPE" == "switchover" ]]; then
    if [[ -z "$SSH_USER" || (-z "$SSH_KEY" && -z "$SSH_PASS") ]]; then
        log_error "SSH credentials required for switchover. Use --ssh-user and --ssh-pass"
        final_json=$(format_result_json "$OPERATION_TYPE" "ERROR" "$current_role" "$current_role" "$steps" "SSH credentials required")
        echo "$final_json" | jq .
        exit 1
    fi
    
    log_info "Executing switchover..."
    exec_result=$(execute_switchover "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$SSH_USER" "$SSH_KEY" "$SSH_PASS")
    log_info "Switchover executed: $exec_result"
else
    log_info "Executing failover..."
    exec_result=$(execute_failover "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$SSH_USER" "$SSH_KEY" "$SSH_PASS")
    log_info "Failover executed: $exec_result"
fi

step3_result=$(format_step_json "execute" "OK" "$exec_result")
steps=$(echo "$steps" | jq ". + [$step3_result]")

log_info "Step 4: Verifying result"
sleep 10

if [[ "$OPERATION_TYPE" == "switchover" ]]; then
    if [[ "$current_role" == "PRIMARY" ]]; then
        expected_role="STANDBY"
    else
        expected_role="PRIMARY"
    fi
else
    expected_role="PRIMARY"
fi

verify_result=$(verify_switchover "$USER" "$PASS" "$HOST" "$PORT" "$SID" "$expected_role")
verified=$(echo "$verify_result" | jq -r '.verified')
new_role=$(echo "$verify_result" | jq -r '.role')

log_info "Verification: role=$new_role, verified=$verified"

step4_result=$(format_step_json "verify" "$verified" "$verify_result")
steps=$(echo "$steps" | jq ". + [$step4_result]")

if [[ "$verified" == "true" ]]; then
    final_status="SUCCESS"
    log_success "$OPERATION_TYPE completed successfully!"
else
    final_status="WARNING"
    log_warning "$OPERATION_TYPE completed but verification pending"
fi

final_json=$(format_result_json "$OPERATION_TYPE" "$final_status" "$current_role" "$new_role" "$steps" "$OPERATION_TYPE completed")
echo "$final_json" | jq .
echo "$final_json" > "${OUTPUT_FILE}.json"

log_info "Output saved to ${OUTPUT_FILE}.json"
