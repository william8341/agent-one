#!/usr/bin/env bash

set -euo pipefail

ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
TNS_ADMIN="${ORACLE_HOME}/network/admin"
export ORACLE_HOME TNS_ADMIN

# 新拓扑（当前状态）
CURRENT_PRIMARY_HOST="192.168.51.121"
CURRENT_PRIMARY_PORT="1521"
CURRENT_PRIMARY_SID="orcldg"
CURRENT_STANDBY_HOST="192.168.51.120"
CURRENT_STANDBY_PORT="1521"
CURRENT_STANDBY_SID="orclm"
STANDBY_OS_USER="oracle"
STANDBY_OS_PASS="jxdl@4819!"

SQLPLUS="$ORACLE_HOME/sqlplus"

log_info() {
    echo -e "\033[34m[INFO]\033[0m $*"
}

log_success() {
    echo -e "\033[32m[SUCCESS]\033[0m $*"
}

log_error() {
    echo -e "\033[31m[ERROR]\033[0m $*"
}

log_warning() {
    echo -e "\033[33m[WARNING]\033[0m $*"
}

run_sql() {
    local host="$1"
    local port="$2"
    local sid="$3"
    local sql="$4"
    
    echo "SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 1000
$sql" | $SQLPLUS -S "sys/oracle@${host}:${port}/${sid} as sysdba" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v "^$"
}

run_sql_ssh() {
    local sql="$1"
    
    sshpass -p "$STANDBY_OS_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${STANDBY_OS_USER}@${CURRENT_STANDBY_HOST}" "
        source ~/.bash_profile >/dev/null 2>&1
        sqlplus -s '/ as sysdba' << 'EOSQL'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 1000
$sql
EOSQL
    " 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v "^$"
}

echo "=========================================="
echo "   Oracle ADG Switchover Rollback"
echo "=========================================="
echo ""
echo "Current Primary: ${CURRENT_PRIMARY_HOST}:${CURRENT_PRIMARY_PORT}/${CURRENT_PRIMARY_SID}"
echo "Current Standby: ${CURRENT_STANDBY_HOST}:${CURRENT_STANDBY_PORT}/${CURRENT_STANDBY_SID}"
echo ""

log_warning "This will rollback the switchover!"
log_warning "Press Ctrl+C within 10 seconds to cancel..."
sleep 10

echo ""
log_info "Step 1: Verifying current roles..."

PRIMARY_ROLE=$(run_sql "$CURRENT_PRIMARY_HOST" "$CURRENT_PRIMARY_PORT" "$CURRENT_PRIMARY_SID" "SELECT database_role FROM v\$database;")
STANDBY_ROLE=$(run_sql_ssh "SELECT database_role FROM v\$database;")

echo "Current Primary Role: $PRIMARY_ROLE"
echo "Current Standby Role: $STANDBY_ROLE"

if [[ "$PRIMARY_ROLE" != "PRIMARY" ]]; then
    log_error "Current primary is not PRIMARY role: $PRIMARY_ROLE"
    exit 1
fi

if [[ "$STANDBY_ROLE" != "PHYSICAL STANDBY" ]]; then
    log_error "Current standby is not STANDBY role: $STANDBY_ROLE"
    exit 1
fi

log_success "Roles verified"

echo ""
log_info "Step 2: Switching current primary to standby..."

PRIMARY_SWITCH=$(run_sql "$CURRENT_PRIMARY_HOST" "$CURRENT_PRIMARY_PORT" "$CURRENT_PRIMARY_SID" "ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY WITH SESSION SHUTDOWN;")

if echo "$PRIMARY_SWITCH" | grep -qi "error"; then
    log_error "Failed to switch current primary to standby"
    echo "$PRIMARY_SWITCH"
    exit 1
fi

log_success "Current primary switched to STANDBY"

sleep 3

log_info "Step 3: Restarting current primary as standby..."

run_sql "$CURRENT_PRIMARY_HOST" "$CURRENT_PRIMARY_PORT" "$CURRENT_PRIMARY_SID" "SHUTDOWN IMMEDIATE;" > /dev/null 2>&1 || true
sleep 5
run_sql "$CURRENT_PRIMARY_HOST" "$CURRENT_PRIMARY_PORT" "$CURRENT_PRIMARY_SID" "STARTUP MOUNT;" > /dev/null 2>&1 || true
sleep 3
run_sql "$CURRENT_PRIMARY_HOST" "$CURRENT_PRIMARY_PORT" "$CURRENT_PRIMARY_SID" "ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;" > /dev/null 2>&1 || true

log_success "Current primary restarted as STANDBY"

log_info "Step 4: Switching current standby to primary..."

STANDBY_SWITCH=$(run_sql_ssh "ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;")

if echo "$STANDBY_SWITCH" | grep -qi "error"; then
    log_error "Failed to switch current standby to primary"
    echo "$STANDBY_SWITCH"
    exit 1
fi

log_success "Current standby switched to PRIMARY"

log_info "Step 5: Restarting current standby as primary..."

run_sql_ssh "SHUTDOWN IMMEDIATE;" > /dev/null 2>&1 || true
sleep 5
run_sql_ssh "STARTUP;" > /dev/null 2>&1 || true

log_success "Current standby restarted as PRIMARY"

echo ""
log_info "Step 6: Verifying rollback..."
sleep 5

NEW_PRIMARY_ROLE=$(run_sql_ssh "SELECT database_role FROM v\$database;")
NEW_STANDBY_ROLE=$(run_sql "$CURRENT_PRIMARY_HOST" "$CURRENT_PRIMARY_PORT" "$CURRENT_PRIMARY_SID" "SELECT database_role FROM v\$database;")

echo ""
echo "=========================================="
echo "   Rollback Complete!"
echo "=========================================="
echo ""
echo "New Primary: ${CURRENT_STANDBY_HOST}:${CURRENT_STANDBY_PORT}/${CURRENT_STANDBY_SID} ($NEW_PRIMARY_ROLE)"
echo "New Standby: ${CURRENT_PRIMARY_HOST}:${CURRENT_PRIMARY_PORT}/${CURRENT_PRIMARY_SID} ($NEW_STANDBY_ROLE)"
echo ""

if [[ "$NEW_PRIMARY_ROLE" == "PRIMARY" && "$NEW_STANDBY_ROLE" == "PHYSICAL STANDBY" ]]; then
    log_success "Rollback completed successfully!"
else
    log_warning "Rollback may not have completed correctly"
    log_warning "Please verify manually"
fi
