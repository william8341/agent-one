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

echo "=========================================="
echo "  Oracle ADG Sync Status Check"
echo "=========================================="
echo ""

show_config

echo ""
log_info "Checking primary database..."

PRIMARY_SEQ=$(run_sql "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID" "$PRIMARY_DB_USER" "$PRIMARY_DB_PASS" "SELECT MAX(sequence#) FROM v\$archived_log WHERE status = 'A';")
PRIMARY_ROLE=$(run_sql "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID" "$PRIMARY_DB_USER" "$PRIMARY_DB_PASS" "SELECT database_role FROM v\$database;")
PRIMARY_STATUS=$(run_sql "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID" "$PRIMARY_DB_USER" "$PRIMARY_DB_PASS" "SELECT open_mode FROM v\$database;")

echo "Primary: $PRIMARY_ROLE | $PRIMARY_STATUS"
echo "Current Sequence: ${PRIMARY_SEQ:-N/A}"

log_info "Checking standby database..."

STANDBY_INFO=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "
SELECT 'APPLIED_SEQ:' || MAX(sequence#) FROM v\$archived_log WHERE applied = 'YES';
SELECT 'RECEIVED_SEQ:' || MAX(sequence#) FROM v\$archived_log;
SELECT 'DB_ROLE:' || database_role FROM v\$database;
SELECT 'OPEN_MODE:' || open_mode FROM v\$database;
SELECT 'MRP_STATUS:' || status FROM v\$managed_standby WHERE process LIKE 'MRP%';
SELECT 'APPLY_LAG:' || value FROM v\$dataguard_stats WHERE name='apply lag';
SELECT 'TRANSPORT_LAG:' || value FROM v\$dataguard_stats WHERE name='transport lag';
SELECT 'GAP_COUNT:' || COUNT(*) FROM v\$archive_gap;
SELECT 'DG_ERRORS:' || COUNT(*) FROM v\$dataguard_status WHERE severity IN ('Error','Fatal');
")

STANDBY_SEQ=$(echo "$STANDBY_INFO" | grep "APPLIED_SEQ:" | cut -d: -f2)
RECEIVED_SEQ=$(echo "$STANDBY_INFO" | grep "RECEIVED_SEQ:" | cut -d: -f2)
STANDBY_ROLE=$(echo "$STANDBY_INFO" | grep "DB_ROLE:" | cut -d: -f2)
STANDBY_MODE=$(echo "$STANDBY_INFO" | grep "OPEN_MODE:" | cut -d: -f2)
MRP_STATUS=$(echo "$STANDBY_INFO" | grep "MRP_STATUS:" | cut -d: -f2)
APPLY_LAG=$(echo "$STANDBY_INFO" | grep "APPLY_LAG:" | cut -d: -f2)
TRANSPORT_LAG=$(echo "$STANDBY_INFO" | grep "TRANSPORT_LAG:" | cut -d: -f2)
GAP_COUNT=$(echo "$STANDBY_INFO" | grep "GAP_COUNT:" | cut -d: -f2)
DG_ERRORS=$(echo "$STANDBY_INFO" | grep "DG_ERRORS:" | cut -d: -f2)

echo "Standby: ${STANDBY_ROLE:-N/A} | ${STANDBY_MODE:-N/A}"
echo "Applied Sequence: ${STANDBY_SEQ:-N/A}"
echo "Received Sequence: ${RECEIVED_SEQ:-N/A}"
echo "MRP Status: ${MRP_STATUS:-N/A}"
echo "Apply Lag: ${APPLY_LAG:-N/A}"
echo "Transport Lag: ${TRANSPORT_LAG:-N/A}"
echo "Archive Gap: ${GAP_COUNT:-0}"
echo "Data Guard Errors: ${DG_ERRORS:-0}"

echo ""
echo "=========================================="
echo "Sync Status Analysis"
echo "=========================================="

echo ""
echo "Sequence Comparison:"
echo "  Primary Current: ${PRIMARY_SEQ:-N/A}"
echo "  Standby Applied: ${STANDBY_SEQ:-N/A}"
echo "  Standby Received: ${RECEIVED_SEQ:-N/A}"

if [[ -n "$PRIMARY_SEQ" && -n "$STANDBY_SEQ" ]]; then
    APPLY_GAP=$((PRIMARY_SEQ - STANDBY_SEQ))
    RECV_GAP=$((PRIMARY_SEQ - RECEIVED_SEQ))
    echo "  Apply Gap: $APPLY_GAP sequences"
    echo "  Receive Gap: $RECV_GAP sequences"
    
    if [[ $APPLY_GAP -eq 0 ]]; then
        log_success "Standby is fully synchronized"
    elif [[ $APPLY_GAP -le 2 ]]; then
        log_warning "Small apply gap ($APPLY_GAP sequences) - normal"
    else
        log_error "Large apply gap ($APPLY_GAP sequences)"
    fi
fi

echo ""
echo "MRP Process Status: ${MRP_STATUS:-N/A}"
if [[ "$MRP_STATUS" == "APPLYING_LOG" || "$MRP_STATUS" == "WAIT_FOR_LOG" ]]; then
    log_success "MRP is running normally"
else
    log_warning "MRP status: $MRP_STATUS"
fi

echo ""
echo "Lag Information:"
echo "  Apply Lag: ${APPLY_LAG:-N/A}"
echo "  Transport Lag: ${TRANSPORT_LAG:-N/A}"

echo ""
echo "Archive Gap: ${GAP_COUNT:-0}"
if [[ -z "$GAP_COUNT" || "$GAP_COUNT" -eq 0 ]]; then
    log_success "No archive gap detected"
else
    log_error "Archive gap detected: $GAP_COUNT missing logs"
fi

echo ""
echo "Data Guard Errors: ${DG_ERRORS:-0}"
if [[ -z "$DG_ERRORS" || "$DG_ERRORS" -eq 0 ]]; then
    log_success "No Data Guard errors"
else
    log_error "Data Guard has $DG_ERRORS errors"
fi

echo ""
echo "=========================================="
echo "Sync Status Summary"
echo "=========================================="

if [[ -n "$PRIMARY_SEQ" && -n "$STANDBY_SEQ" && $APPLY_GAP -le 2 && "$MRP_STATUS" == "APPLYING_LOG" && -z "$DG_ERRORS" ]]; then
    log_success "Database sync is normal"
    echo "  - Apply gap: $APPLY_GAP sequences"
    echo "  - MRP status: $MRP_STATUS"
    echo "  - No errors"
else
    log_warning "Please check sync status"
fi
