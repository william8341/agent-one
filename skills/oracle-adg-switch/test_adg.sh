#!/usr/bin/env bash

set -euo pipefail

ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
TNS_ADMIN="${ORACLE_HOME}/network/admin"
export ORACLE_HOME TNS_ADMIN

HOST="$1"
PORT="${2:-1521}"
SID="$3"

SQLPLUS="$ORACLE_HOME/sqlplus"
CONN="sys/oracle@${HOST}:${PORT}/${SID} as sysdba"

run_sql() {
    local sql="$1"
    local tmpfile="/tmp/adg_check_$$.sql"
    
    cat > "$tmpfile" << 'EOF'
SET HEADING OFF FEEDBACK OFF
EOF
    
    echo "$sql" >> "$tmpfile"
    
    cat >> "$tmpfile" << 'EOF'
EXIT
EOF
    
    $SQLPLUS "$CONN" "@$tmpfile" 2>/dev/null
    rm -f "$tmpfile"
}

echo "=== Oracle ADG Prerequisites Check ==="
echo "Host: $HOST:$PORT"
echo "SID: $SID"
echo ""

ROLE=$(run_sql "SELECT database_role FROM v\$database;" | grep -E "PRIMARY|STANDBY" | head -1)
echo "Database Role: $ROLE"

SWITCHOVER=$(run_sql "SELECT switchover_status FROM v\$database;" | grep -E "SESSIONS ACTIVE|TO STANDBY|TO PRIMARY|NOT ALLOWED" | tr -d ' \t')
echo "Switchover Status: $SWITCHOVER"

LOGMODE=$(run_sql "SELECT log_mode FROM v\$database;" | grep -E "^(ARCHIVELOG|NOARCHIVELOG)$" | head -1)
echo "Log Mode: $LOGMODE"

STATUS=$(run_sql "SELECT status FROM v\$instance;" | grep -E "^(OPEN|MOUNT)$" | head -1)
echo "Database Status: $STATUS"

TRANSACTIONS=$(run_sql "SELECT COUNT(*) FROM v\$transaction;" | grep -E "^[0-9]+$" | head -1)
echo "Active Transactions: $TRANSACTIONS"

echo ""

# Check switchover prerequisites
if [[ "$ROLE" == "PRIMARY" ]]; then
    echo "=== Switchover Prerequisites ==="
    if [[ "$LOGMODE" == "ARCHIVELOG" ]]; then
        echo "[OK] Database is in ARCHIVELOG mode"
    else
        echo "[FAIL] Database is not in ARCHIVELOG mode"
    fi
    
    if [[ "$STATUS" == "OPEN" ]]; then
        echo "[OK] Database is OPEN"
    else
        echo "[FAIL] Database is not OPEN"
    fi
    
    if [[ "$SWITCHOVER" == "SESSIONS ACTIVE" || "$SWITCHOVER" == "TO STANDBY" ]]; then
        echo "[OK] Switchover status allows switchover"
    else
        echo "[FAIL] Switchover status does not allow switchover: $SWITCHOVER"
    fi
    
    if [[ "$TRANSACTIONS" == "0" || -z "$TRANSACTIONS" ]]; then
        echo "[OK] No active transactions"
    else
        echo "[WARN] $TRANSACTIONS active transactions found"
    fi
fi
