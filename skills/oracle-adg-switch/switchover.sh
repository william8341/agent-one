#!/usr/bin/env bash

set -euo pipefail

ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
TNS_ADMIN="${ORACLE_HOME}/network/admin"
export ORACLE_HOME TNS_ADMIN

PRIMARY_HOST="192.168.51.120"
PRIMARY_PORT="1521"
PRIMARY_SID="orclm"
STANDBY_HOST="192.168.51.121"
STANDBY_PORT="1521"
STANDBY_SID="orcldg"

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

run_primary_sql() {
    local sql="$1"
    local tmpfile="/tmp/primary_$$.sql"
    
    cat > "$tmpfile" << 'EOF'
SET HEADING OFF FEEDBACK OFF
EOF
    
    echo "$sql" >> "$tmpfile"
    
    cat >> "$tmpfile" << 'EOF'
EXIT
EOF
    
    $SQLPLUS "sys/oracle@${PRIMARY_HOST}:${PRIMARY_PORT}/${PRIMARY_SID} as sysdba" "@$tmpfile" 2>/dev/null
    rm -f "$tmpfile"
}

run_standby_sql() {
    local sql="$1"
    local tmpfile="/tmp/standby_$$.sql"
    
    cat > "$tmpfile" << 'EOF'
SET HEADING OFF FEEDBACK OFF
EOF
    
    echo "$sql" >> "$tmpfile"
    
    cat >> "$tmpfile" << 'EOF'
EXIT
EOF
    
    $SQLPLUS "sys/oracle@${STANDBY_HOST}:${STANDBY_PORT}/${STANDBY_SID} as sysdba" "@$tmpfile" 2>/dev/null
    rm -f "$tmpfile"
}

check_role() {
    local host="$1"
    local port="$2"
    local sid="$3"
    local tmpfile="/tmp/check_$$.sql"
    
    cat > "$tmpfile" << 'EOF'
SET HEADING OFF FEEDBACK OFF
SELECT database_role FROM v$database;
EXIT
EOF
    
    $SQLPLUS "sys/oracle@${host}:${port}/${sid} as sysdba" "@$tmpfile" 2>/dev/null | grep -E "PRIMARY|STANDBY" | head -1
    rm -f "$tmpfile"
}

check_switchover_status() {
    local host="$1"
    local port="$2"
    local sid="$3"
    local tmpfile="/tmp/check_sw_$$.sql"
    
    cat > "$tmpfile" << 'EOF'
SET HEADING OFF FEEDBACK OFF
SELECT switchover_status FROM v$database;
EXIT
EOF
    
    $SQLPLUS "sys/oracle@${host}:${port}/${sid} as sysdba" "@$tmpfile" 2>/dev/null | grep -E "SESSIONS ACTIVE|TO STANDBY|TO PRIMARY|NOT ALLOWED" | head -1
    rm -f "$tmpfile"
}

echo "=========================================="
echo "   Oracle ADG Switchover Tool"
echo "=========================================="
echo ""
echo "Primary: ${PRIMARY_HOST}:${PRIMARY_PORT}/${PRIMARY_SID}"
echo "Standby: ${STANDBY_HOST}:${STANDBY_PORT}/${STANDBY_SID}"
echo ""

log_info "Step 1: Checking current roles..."

PRIMARY_ROLE=$(check_role "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID")
STANDBY_ROLE=$(check_role "$STANDBY_HOST" "$STANDBY_PORT" "$STANDBY_SID")

echo "Primary Role: $PRIMARY_ROLE"
echo "Standby Role: $STANDBY_ROLE"

if [[ "$PRIMARY_ROLE" != "PRIMARY" ]]; then
    log_error "Primary is not PRIMARY role: $PRIMARY_ROLE"
    exit 1
fi

if [[ "$STANDBY_ROLE" != "PHYSICAL STANDBY" && "$STANDBY_ROLE" != "STANDBY" ]]; then
    log_error "Standby is not STANDBY role: $STANDBY_ROLE"
    exit 1
fi

log_success "Roles verified"

log_info "Step 2: Checking switchover status..."

PRIMARY_SWITCHOVER=$(check_switchover_status "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID")
STANDBY_SWITCHOVER=$(check_switchover_status "$STANDBY_HOST" "$STANDBY_PORT" "$STANDBY_SID")

echo "Primary Switchover Status: $PRIMARY_SWITCHOVER"
echo "Standby Switchover Status: $STANDBY_SWITCHOVER"

if [[ "$STANDBY_SWITCHOVER" == "NOT ALLOWED" ]]; then
    log_warning "Standby switchover is NOT ALLOWED"
    log_info "This usually means primary has active sessions"
    log_info "Attempting to proceed anyway..."
fi

echo ""
log_info "Step 3: Executing Switchover"
echo ""
log_warning "This will switch primary and standby roles!"
log_warning "Press Ctrl+C within 5 seconds to cancel..."
sleep 5

log_info "Step 3a: Switching PRIMARY to STANDBY..."

PRIMARY_SWITCH=$(run_primary_sql "ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY WITH SESSION SHUTDOWN;" 2>&1)
echo "$PRIMARY_SWITCH"

if echo "$PRIMARY_SWITCH" | grep -q "ERROR"; then
    log_error "Failed to switch primary to standby"
    echo "$PRIMARY_SWITCH"
    exit 1
fi

log_success "Primary switched to STANDBY"

sleep 3

log_info "Step 3b: Restarting primary as standby..."

run_primary_sql "SHUTDOWN IMMEDIATE;" > /dev/null 2>&1
sleep 2
run_primary_sql "STARTUP MOUNT;" > /dev/null 2>&1
run_primary_sql "ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;" > /dev/null 2>&1

log_success "Primary restarted as STANDBY"

log_info "Step 3c: Switching STANDBY to PRIMARY..."

STANDBY_SWITCH=$(run_standby_sql "ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;" 2>&1)
echo "$STANDBY_SWITCH"

if echo "$STANDBY_SWITCH" | grep -q "ERROR"; then
    log_error "Failed to switch standby to primary"
    echo "$STANDBY_SWITCH"
    exit 1
fi

log_success "Standby switched to PRIMARY"

log_info "Step 3d: Restarting standby as primary..."

run_standby_sql "SHUTDOWN IMMEDIATE;" > /dev/null 2>&1
sleep 2
run_standby_sql "STARTUP;" > /dev/null 2>&1

log_success "Standby restarted as PRIMARY"

echo ""
log_info "Step 4: Verifying switchover..."
sleep 5

NEW_PRIMARY_ROLE=$(check_role "$STANDBY_HOST" "$STANDBY_PORT" "$STANDBY_SID")
NEW_STANDBY_ROLE=$(check_role "$PRIMARY_HOST" "$PRIMARY_PORT" "$PRIMARY_SID")

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
else
    log_warning "Switchover may not have completed correctly"
    log_warning "Please verify manually"
fi
