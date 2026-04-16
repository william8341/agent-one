#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/config.sh"

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
    local db_user="$4"
    local db_pass="$5"
    local sql="$6"
    
    echo "SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 1000
$sql" | $SQLPLUS -S "${db_user}/${db_pass}@${host}:${port}/${sid} as sysdba" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v "^$"
}

run_sql_ssh() {
    local host="$1"
    local os_user="$2"
    local os_pass="$3"
    local sql="$4"
    
    sshpass -p "$os_pass" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=$SSH_TIMEOUT "${os_user}@${host}" "
        source ~/.bash_profile >/dev/null 2>&1
        sqlplus -s '/ as sysdba' << 'EOSQL'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 1000
$sql
EOSQL
    " 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v "^$"
}

check_role() {
    local host="$1"
    local port="$2"
    local sid="$3"
    local db_user="$4"
    local db_pass="$5"
    
    run_sql "$host" "$port" "$sid" "$db_user" "$db_pass" "SELECT database_role FROM v\$database;"
}

check_role_ssh() {
    local host="$1"
    local os_user="$2"
    local os_pass="$3"
    
    run_sql_ssh "$host" "$os_user" "$os_pass" "SELECT database_role FROM v\$database;"
}

check_db_status_ssh() {
    local host="$1"
    local os_user="$2"
    local os_pass="$3"
    
    local result=$(sshpass -p "$os_pass" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=$SSH_TIMEOUT "${os_user}@${host}" "
        source ~/.bash_profile >/dev/null 2>&1
        sqlplus -s '/ as sysdba' << 'EOSQL' 2>&1
SET HEADING OFF FEEDBACK OFF
SELECT status FROM v\$instance;
EXIT
EOSQL
    " 2>/dev/null)
    
    if echo "$result" | grep -qi "ORA-01034\|ORA-01012\|not connected"; then
        echo "DOWN"
    elif echo "$result" | grep -qi "OPEN\|MOUNTED\|STARTED"; then
        echo "$result" | grep -oE "(OPEN|MOUNTED|STARTED)" | head -1
    else
        echo "DOWN"
    fi
}

run_sql_ssh_safe() {
    local host="$1"
    local os_user="$2"
    local os_pass="$3"
    local sql="$4"
    
    local result=$(sshpass -p "$os_pass" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=$SSH_TIMEOUT "${os_user}@${host}" "
        source ~/.bash_profile >/dev/null 2>&1
        sqlplus -s '/ as sysdba' << 'EOSQL' 2>&1
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 1000
$sql
EOSQL
    " 2>/dev/null)
    
    if echo "$result" | grep -qi "ORA-01034\|ORA-01012\|not connected"; then
        echo "DATABASE_DOWN"
        return 1
    fi
    
    echo "$result" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v "^$"
    return 0
}

echo "=========================================="
echo "   Oracle ADG Switchover Execution"
echo "=========================================="
echo ""

show_config

echo ""
log_info "Step 1: Verifying current roles..."

PRIMARY_ROLE=$(check_role "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID" "$PRIMARY_DB_USER" "$PRIMARY_DB_PASS")
STANDBY_ROLE=$(check_role "$STANDBY_HOST" "$STANDBY_PORT" "$STANDBY_SID" "$STANDBY_DB_USER" "$STANDBY_DB_PASS")

echo "Primary Role: $PRIMARY_ROLE"
echo "Standby Role: $STANDBY_ROLE"

if [[ "$PRIMARY_ROLE" != "PRIMARY" ]]; then
    log_error "Primary is not PRIMARY role: $PRIMARY_ROLE"
    exit 1
fi

if [[ "$STANDBY_ROLE" != "PHYSICAL STANDBY" ]]; then
    log_error "Standby is not STANDBY role: $STANDBY_ROLE"
    exit 1
fi

log_success "Roles verified"

echo ""
log_warning "THIS WILL EXECUTE ADG SWITCHOVER!"
log_warning "Press Ctrl+C within 10 seconds to cancel..."
sleep 10

echo ""
log_info "Step 2: Switching PRIMARY to STANDBY..."

PRIMARY_SWITCH=$(run_sql_ssh_safe "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY WITH SESSION SHUTDOWN;")

if [[ "$PRIMARY_SWITCH" == "DATABASE_DOWN" ]]; then
    log_warning "Primary database is already down, continuing..."
elif echo "$PRIMARY_SWITCH" | grep -qi "error"; then
    log_error "Failed to switch primary to standby"
    echo "$PRIMARY_SWITCH"
    exit 1
fi

log_success "Primary switched to STANDBY"

log_info "Step 3: Waiting for database to shutdown..."
sleep 10

log_info "Step 4: Checking primary database status..."
PRIMARY_STATUS=$(check_db_status_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS")
echo "Primary Status: $PRIMARY_STATUS"

if [[ "$PRIMARY_STATUS" == "DOWN" || "$PRIMARY_STATUS" == "STARTED" ]]; then
    log_info "Database is down, starting in MOUNT mode..."
    run_sql_ssh_safe "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "STARTUP MOUNT;" > /dev/null 2>&1 || true
else
    log_info "Database is in $PRIMARY_STATUS, starting MRP..."
fi

sleep 3

log_info "Step 5: Configuring primary as standby..."
run_sql_ssh_safe "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;" > /dev/null 2>&1 || true

log_success "Primary restarted as STANDBY"

log_info "Step 6: Checking standby database status..."
STANDBY_STATUS=$(check_db_status_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS")
echo "Standby Status: $STANDBY_STATUS"

log_info "Step 7: Switching STANDBY to PRIMARY..."

STANDBY_SWITCH=$(run_sql_ssh_safe "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;")

if [[ "$STANDBY_SWITCH" == "DATABASE_DOWN" ]]; then
    log_warning "Standby database is down, will start it as primary..."
elif echo "$STANDBY_SWITCH" | grep -qi "error"; then
    log_error "Failed to switch standby to primary"
    echo "$STANDBY_SWITCH"
    exit 1
fi

log_success "Standby switched to PRIMARY"

log_info "Step 8: Waiting for database to shutdown..."
sleep 10

log_info "Step 9: Starting new primary..."
STANDBY_STATUS=$(check_db_status_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS")
echo "Standby Status: $STANDBY_STATUS"

if [[ "$STANDBY_STATUS" == "DOWN" || "$STANDBY_STATUS" == "STARTED" ]]; then
    log_info "Database is down, starting in OPEN mode..."
    run_sql_ssh_safe "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "STARTUP;" > /dev/null 2>&1 || true
else
    log_info "Database is in $STANDBY_STATUS, shutting down and restarting..."
    run_sql_ssh_safe "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SHUTDOWN IMMEDIATE;" > /dev/null 2>&1 || true
    sleep 5
    run_sql_ssh_safe "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "STARTUP;" > /dev/null 2>&1 || true
fi

log_success "Standby restarted as PRIMARY"

echo ""
log_info "Step 10: Verifying switchover..."
sleep 5

NEW_PRIMARY_ROLE=$(check_role_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS")
NEW_STANDBY_ROLE=$(check_role_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS")

echo ""
echo "=========================================="
echo "   Switchover Complete!"
echo "=========================================="
echo ""
echo "New Primary: ${STANDBY_HOST}:${STANDBY_PORT}/${STANDBY_SID} ($NEW_PRIMARY_ROLE)"
echo "New Standby: ${PRIMARY_HOST}:${PRIMARY_PORT}/${PRIMARY_SID} ($NEW_STANDBY_ROLE)"
echo ""

if [[ "$NEW_PRIMARY_ROLE" == "PRIMARY" && "$NEW_STANDBY_ROLE" == "PHYSICAL STANDBY" ]]; then
    log_success "Switchover completed successfully!"
    
    log_info "Step 11: Updating configuration..."
    update_config_role "$STANDBY_SID" "$PRIMARY_SID"
    log_success "Configuration updated"
else
    log_warning "Switchover may not have completed correctly"
    log_warning "Please verify manually"
fi
