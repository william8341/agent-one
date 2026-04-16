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

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

check_result() {
    local status="$1"
    local msg="$2"
    if [[ "$status" == "PASS" ]]; then
        log_success "$msg"
        PASS_COUNT=$((PASS_COUNT + 1))
    elif [[ "$status" == "FAIL" ]]; then
        log_error "$msg"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        log_warning "$msg"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi
}

echo "=========================================="
echo "  Oracle ADG Switchover Pre-Check"
echo "=========================================="
echo ""

show_config

echo ""
echo "=========================================="
echo "一、切换前通用检查（主+备都查）"
echo "=========================================="
echo ""

log_info "1. 数据库角色与状态"

PRIMARY_DB=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT db_unique_name || '|' || database_role || '|' || open_mode FROM v\$database;")
STANDBY_DB=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT db_unique_name || '|' || database_role || '|' || open_mode FROM v\$database;")

PRIMARY_ROLE=$(echo "$PRIMARY_DB" | cut -d'|' -f2)
PRIMARY_OPEN=$(echo "$PRIMARY_DB" | cut -d'|' -f3)
STANDBY_ROLE=$(echo "$STANDBY_DB" | cut -d'|' -f2)
STANDBY_OPEN=$(echo "$STANDBY_DB" | cut -d'|' -f3)

echo "  Primary: $PRIMARY_DB"
echo "  Standby: $STANDBY_DB"

[[ "$PRIMARY_ROLE" == "PRIMARY" ]] && check_result "PASS" "Primary role: PRIMARY" || check_result "FAIL" "Primary role is NOT PRIMARY: $PRIMARY_ROLE"
[[ "$STANDBY_ROLE" == "PHYSICAL STANDBY" ]] && check_result "PASS" "Standby role: PHYSICAL STANDBY" || check_result "FAIL" "Standby role is NOT PHYSICAL STANDBY: $STANDBY_ROLE"

echo ""
log_info "2. 数据库版本、补丁一致性"

PRIMARY_VER=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT version FROM v\$instance;")
STANDBY_VER=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT version FROM v\$instance;")

echo "  Primary: $PRIMARY_VER"
echo "  Standby: $STANDBY_VER"

[[ "$PRIMARY_VER" == "$STANDBY_VER" ]] && check_result "PASS" "Database versions match" || check_result "FAIL" "Database versions do NOT match"

echo ""
log_info "3. 实例状态"

PRIMARY_INST=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT status FROM v\$instance;")
STANDBY_INST=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT status FROM v\$instance;")

echo "  Primary: $PRIMARY_INST"
echo "  Standby: $STANDBY_INST"

[[ "$PRIMARY_INST" == "OPEN" ]] && check_result "PASS" "Primary instance is OPEN" || check_result "FAIL" "Primary instance is NOT OPEN: $PRIMARY_INST"
[[ "$STANDBY_INST" == "OPEN" || "$STANDBY_INST" == "MOUNTED" ]] && check_result "PASS" "Standby instance is $STANDBY_INST" || check_result "FAIL" "Standby instance status unexpected: $STANDBY_INST"

echo ""
log_info "4. 参数检查"

PRIMARY_LOG_CONFIG=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT value FROM v\$parameter WHERE name = 'log_archive_config';")
PRIMARY_STBY_FILE=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT value FROM v\$parameter WHERE name = 'standby_file_management';")
STANDBY_STBY_FILE=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT value FROM v\$parameter WHERE name = 'standby_file_management';")

echo "  log_archive_config (Primary): ${PRIMARY_LOG_CONFIG:-N/A}"
echo "  standby_file_management (Primary): ${PRIMARY_STBY_FILE:-N/A}"
echo "  standby_file_management (Standby): ${STANDBY_STBY_FILE:-N/A}"

[[ -n "$PRIMARY_LOG_CONFIG" ]] && check_result "PASS" "log_archive_config is set" || check_result "FAIL" "log_archive_config is NOT set"
[[ "$PRIMARY_STBY_FILE" == "AUTO" ]] && check_result "PASS" "Primary standby_file_management=AUTO" || check_result "WARN" "Primary standby_file_management is not AUTO: $PRIMARY_STBY_FILE"
[[ "$STANDBY_STBY_FILE" == "AUTO" ]] && check_result "PASS" "Standby standby_file_management=AUTO" || check_result "WARN" "Standby standby_file_management is not AUTO: $STANDBY_STBY_FILE"

echo ""
echo "=========================================="
echo "二、主库检查"
echo "=========================================="
echo ""

log_info "1. 主库活动会话"

ACTIVE_SESSIONS=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT COUNT(*) FROM v\$session WHERE status='ACTIVE' AND username IS NOT NULL;")

echo "  Active Sessions: ${ACTIVE_SESSIONS:-0}"

[[ -n "$ACTIVE_SESSIONS" && "$ACTIVE_SESSIONS" -gt 0 ]] && check_result "WARN" "Primary has $ACTIVE_SESSIONS active sessions - recommend stopping business traffic" || check_result "PASS" "No active user sessions"

echo ""
log_info "2. 归档日志状态"

PRIMARY_SEQ=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT MAX(sequence#) FROM v\$archived_log WHERE status = 'A';")
ARCH_STATUS=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT status FROM v\$archive_dest WHERE dest_id=2;")

echo "  Current Sequence: ${PRIMARY_SEQ:-N/A}"
echo "  Archive Dest 2 Status: ${ARCH_STATUS:-N/A}"

[[ -n "$PRIMARY_SEQ" ]] && check_result "PASS" "Archive log sequence: $PRIMARY_SEQ" || check_result "FAIL" "Cannot determine archive log sequence"
[[ "$ARCH_STATUS" == "VALID" ]] && check_result "PASS" "Archive dest status: VALID" || check_result "WARN" "Archive dest status: $ARCH_STATUS"

echo ""
echo "=========================================="
echo "三、备库检查"
echo "=========================================="
echo ""

log_info "1. 日志应用状态（MRP进程）"

MRP_STATUS=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT status FROM v\$managed_standby WHERE process LIKE 'MRP%';")

echo "  MRP Status: ${MRP_STATUS:-N/A}"

if [[ -n "$MRP_STATUS" ]]; then
    [[ "$MRP_STATUS" == "APPLYING_LOG" || "$MRP_STATUS" == "WAIT_FOR_LOG" ]] && check_result "PASS" "MRP status: $MRP_STATUS" || check_result "WARN" "MRP status: $MRP_STATUS"
else
    check_result "WARN" "MRP process not found (may be using real-time apply)"
fi

echo ""
log_info "2. 主备日志序列一致性"

STANDBY_SEQ=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT MAX(sequence#) FROM v\$archived_log WHERE applied = 'YES';")
STANDBY_RECEIVED=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT MAX(sequence#) FROM v\$archived_log;")
STANDBY_GAP=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT COUNT(*) FROM v\$archive_gap;")

echo "  Primary Current Sequence: ${PRIMARY_SEQ:-N/A}"
echo "  Standby Applied Sequence: ${STANDBY_SEQ:-N/A}"
echo "  Standby Received Sequence: ${STANDBY_RECEIVED:-N/A}"
echo "  Archive Gap Count: ${STANDBY_GAP:-0}"

if [[ -n "$PRIMARY_SEQ" && -n "$STANDBY_SEQ" ]]; then
    GAP=$((PRIMARY_SEQ - STANDBY_SEQ))
    echo "  Replication Gap: $GAP sequences"
    [[ $GAP -eq 0 ]] && check_result "PASS" "No replication gap - fully synchronized"
    [[ $GAP -gt 0 && $GAP -le 5 ]] && check_result "WARN" "Small replication gap ($GAP sequences)"
    [[ $GAP -gt 5 ]] && check_result "FAIL" "Large replication gap ($GAP sequences)"
fi

[[ -z "$STANDBY_GAP" || "$STANDBY_GAP" -eq 0 ]] && check_result "PASS" "No archive gap detected" || check_result "FAIL" "Archive gap detected: $STANDBY_GAP missing logs"

echo ""
log_info "3. 备库错误检查"

DG_ERRORS=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT COUNT(*) FROM v\$dataguard_status WHERE severity IN ('Error','Fatal');")

[[ -z "$DG_ERRORS" || "$DG_ERRORS" -eq 0 ]] && check_result "PASS" "No Data Guard errors" || check_result "FAIL" "Data Guard has $DG_ERRORS errors"

echo ""
log_info "4. 主备延迟"

APPLY_LAG=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT value FROM v\$dataguard_stats WHERE name='apply lag';")
TRANSPORT_LAG=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT value FROM v\$dataguard_stats WHERE name='transport lag';")

echo "  Apply Lag: ${APPLY_LAG:-N/A}"
echo "  Transport Lag: ${TRANSPORT_LAG:-N/A}"

[[ -n "$APPLY_LAG" ]] && check_result "PASS" "Apply lag: $APPLY_LAG" || check_result "WARN" "Cannot determine apply lag"
[[ -n "$TRANSPORT_LAG" ]] && check_result "PASS" "Transport lag: $TRANSPORT_LAG" || check_result "WARN" "Cannot determine transport lag"

echo ""
log_info "5. Switchover状态"

PRIMARY_SW=$(run_sql_ssh "$PRIMARY_HOST" "$PRIMARY_OS_USER" "$PRIMARY_OS_PASS" "SELECT switchover_status FROM v\$database;")
STANDBY_SW=$(run_sql_ssh "$STANDBY_HOST" "$STANDBY_OS_USER" "$STANDBY_OS_PASS" "SELECT switchover_status FROM v\$database;")

echo "  Primary Switchover Status: ${PRIMARY_SW:-N/A}"
echo "  Standby Switchover Status: ${STANDBY_SW:-N/A}"

[[ "$PRIMARY_SW" == "TO STANDBY" || "$PRIMARY_SW" == "SESSIONS ACTIVE" ]] && check_result "PASS" "Primary switchover status: $PRIMARY_SW" || check_result "FAIL" "Primary switchover status: $PRIMARY_SW"

if [[ "$STANDBY_SW" == "TO PRIMARY" || "$STANDBY_SW" == "SESSIONS ACTIVE" ]]; then
    check_result "PASS" "Standby switchover status: $STANDBY_SW"
elif [[ "$STANDBY_SW" == "NOT ALLOWED" ]]; then
    check_result "WARN" "Standby switchover NOT ALLOWED (may need to stop primary sessions)"
else
    check_result "FAIL" "Standby switchover status: $STANDBY_SW"
fi

echo ""
echo "=========================================="
echo "四、切换前收尾确认"
echo "=========================================="
echo ""

log_warning "请人工确认以下事项："
echo "  1. 业务确认：应用已切流/停业务"
echo "  2. 备份确认：主库最近有有效全备"
echo "  3. 网络确认：主备网络连接正常"
echo ""

echo "=========================================="
echo "检查结果汇总"
echo "=========================================="
echo ""
echo "  PASS: $PASS_COUNT"
echo "  WARN: $WARN_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo ""

if [[ $FAIL_COUNT -gt 0 ]]; then
    log_error "存在 $FAIL_COUNT 个严重问题，请先解决后再执行切换"
    exit 1
elif [[ $WARN_COUNT -gt 0 ]]; then
    log_warning "存在 $WARN_COUNT 个警告，请确认后决定是否继续"
    echo ""
    log_info "如果确认无问题，执行: ./execute_switchover.sh"
else
    log_success "所有检查通过，可以执行切换"
    echo ""
    log_info "执行: ./execute_switchover.sh"
fi
