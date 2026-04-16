#!/usr/bin/env bash

ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
export ORACLE_HOME
export PATH="$ORACLE_HOME:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/oracle.sh"
source "$LIB_DIR/formatter.sh"

HOST="$1"; PORT="$2"; USER="$3"; PASS="$4"; SID="$5"; STATE_DIR="$6"

STATE_FILE="$STATE_DIR/02_session.json"

if [[ ! -f "$STATE_FILE" ]]; then
    format_fix_result "fix_kill_session.sh" "SKIPPED" "No state file found"
    exit 0
fi

BLOCKER_SID=$(cat "$STATE_FILE" | jq -r '.details[0].blocker // empty')
BLOCKER_SERIAL=$(cat "$STATE_FILE" | jq -r '.details[0].serial // empty')

if [[ -z "$BLOCKER_SERIAL" || "$BLOCKER_SERIAL" == "null" ]]; then
    BLOCKER_SERIAL=$(cat "$STATE_FILE" | jq -r '.details[0].serial // empty')
fi

if [[ -z "$BLOCKER_SID" || "$BLOCKER_SID" == "null" ]]; then
    format_fix_result "fix_kill_session.sh" "SKIPPED" "No blocking session to fix"
    exit 0
fi

dsn="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=$HOST)(PORT=$PORT))(CONNECT_DATA=(SERVICE_NAME=$SID)))"

# Add sysdba privilege for sys user
connect_as=""
if [[ "$USER" == "sys" || "$USER" == "SYS" ]]; then
    connect_as="as sysdba"
fi

echo "[INFO] Attempting to kill blocking session SID=$BLOCKER_SID SERIAL=$BLOCKER_SERIAL"

# First attempt: ALTER SYSTEM KILL SESSION
echo "SET HEADING OFF FEEDBACK OFF
ALTER SYSTEM KILL SESSION '$BLOCKER_SID,$BLOCKER_SERIAL' IMMEDIATE;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" > /tmp/kill_result_$$.txt 2>&1

if grep -q "System altered" /tmp/kill_result_$$.txt; then
    echo "[INFO] Session marked for kill, waiting..."
    sleep 3
    
    SESSION_EXISTS=$(echo "SET HEADING OFF FEEDBACK OFF
SELECT COUNT(*) FROM v\$session WHERE sid=$BLOCKER_SID AND serial#=$BLOCKER_SERIAL;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" | tr -d ' \n\r')
    
    if [[ "$SESSION_EXISTS" == "0" ]]; then
        format_fix_result "fix_kill_session.sh" "SUCCESS" "Killed session SID=$BLOCKER_SID SERIAL=$BLOCKER_SERIAL via ALTER SYSTEM" > "$STATE_DIR/fix_02_session.json"
        rm -f /tmp/kill_result_$$.txt
        exit 0
    fi
    
    # Check if session is marked for kill but still exists
    SESSION_STATUS=$(echo "SET HEADING OFF FEEDBACK OFF
SELECT status FROM v\$session WHERE sid=$BLOCKER_SID AND serial#=$BLOCKER_SERIAL;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" | tr -d ' \n\r')
    
    if [[ "$SESSION_STATUS" == "KILLED" ]]; then
        echo "[INFO] Session is KILLED but still exists in v\$session, using OS kill..."
    fi
elif grep -q "ORA-00030" /tmp/kill_result_$$.txt; then
    format_fix_result "fix_kill_session.sh" "SUCCESS" "Session SID=$BLOCKER_SERIAL already gone (ORA-00030)" > "$STATE_DIR/fix_02_session.json"
    rm -f /tmp/kill_result_$$.txt
    exit 0
fi

# Second attempt: Get SPID and use OS kill
echo "SET HEADING OFF FEEDBACK OFF
SELECT p.spid FROM v\$session s, v\$process p WHERE s.sid=$BLOCKER_SID AND s.serial#=$BLOCKER_SERIAL AND s.paddr=p.addr;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" > /tmp/spid_result_$$.txt 2>&1

SPID=$(cat /tmp/spid_result_$$.txt | tr -d ' \n\r')

if [[ -n "$SPID" && "$SPID" != "null" && "$SPID" =~ ^[0-9]+$ ]]; then
    echo "[INFO] Found SPID=$SPID, attempting OS kill..."
    kill -9 "$SPID" 2>/dev/null
    sleep 2
    
    SESSION_EXISTS_AFTER=$(echo "SET HEADING OFF FEEDBACK OFF
SELECT COUNT(*) FROM v\$session WHERE sid=$BLOCKER_SID AND serial#=$BLOCKER_SERIAL;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" | tr -d ' \n\r')
    
    if [[ "$SESSION_EXISTS_AFTER" == "0" ]]; then
        format_fix_result "fix_kill_session.sh" "SUCCESS" "Killed session SID=$BLOCKER_SID via OS kill -9 $SPID" > "$STATE_DIR/fix_02_session.json"
        rm -f /tmp/kill_result_$$.txt /tmp/spid_result_$$.txt
        exit 0
    fi
fi

# Third attempt: Retry ALTER SYSTEM KILL after OS kill
echo "SET HEADING OFF FEEDBACK OFF
ALTER SYSTEM KILL SESSION '$BLOCKER_SID,$BLOCKER_SERIAL' IMMEDIATE;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" > /tmp/kill_retry_$$.txt 2>&1

if grep -q "ORA-00030" /tmp/kill_retry_$$.txt || grep -q "ORA-00031" /tmp/kill_retry_$$.txt; then
    format_fix_result "fix_kill_session.sh" "SUCCESS" "Session SID=$BLOCKER_SID already killed (ORA-00030/31)" > "$STATE_DIR/fix_02_session.json"
    rm -f /tmp/kill_result_$$.txt /tmp/kill_retry_$$.txt
    exit 0
fi

sleep 3

SESSION_FINAL=$(echo "SET HEADING OFF FEEDBACK OFF
SELECT COUNT(*) FROM v\$session WHERE sid=$BLOCKER_SID AND serial#=$BLOCKER_SERIAL;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" | tr -d ' \n\r')

if [[ "$SESSION_FINAL" == "0" ]]; then
    format_fix_result "fix_kill_session.sh" "SUCCESS" "Killed session SID=$BLOCKER_SID SERIAL=$BLOCKER_SERIAL" > "$STATE_DIR/fix_02_session.json"
else
    # Last resort: try to get new SPID and kill again
    echo "[WARNING] Session still exists, trying OS kill again..."
    
    SPID_LAST=$(echo "SET HEADING OFF FEEDBACK OFF
SELECT p.spid FROM v\$session s, v\$process p WHERE s.sid=$BLOCKER_SID AND s.serial#=$BLOCKER_SERIAL AND s.paddr=p.addr;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" | tr -d ' \n\r')
    
    if [[ -n "$SPID_LAST" && "$SPID_LAST" =~ ^[0-9]+$ ]]; then
        kill -9 "$SPID_LAST" 2>/dev/null
        sleep 2
        
        SESSION_CHECK=$(echo "SET HEADING OFF FEEDBACK OFF
SELECT COUNT(*) FROM v\$session WHERE sid=$BLOCKER_SID AND serial#=$BLOCKER_SERIAL;
EXIT" | sqlplus -s "$USER/$PASS@$dsn $connect_as" | tr -d ' \n\r')
        
        if [[ "$SESSION_CHECK" == "0" ]]; then
            format_fix_result "fix_kill_session.sh" "SUCCESS" "Killed session SID=$BLOCKER_SID via OS kill -9 $SPID_LAST" > "$STATE_DIR/fix_02_session.json"
        else
            format_fix_result "fix_kill_session.sh" "ERROR" "Failed to kill session SID=$BLOCKER_SID SERIAL=$BLOCKER_SERIAL after multiple attempts" > "$STATE_DIR/fix_02_session.json"
        fi
    else
        format_fix_result "fix_kill_session.sh" "ERROR" "Failed to kill session SID=$BLOCKER_SID SERIAL=$BLOCKER_SERIAL" > "$STATE_DIR/fix_02_session.json"
    fi
fi

rm -f /tmp/kill_result_$$.txt /tmp/spid_result_$$.txt /tmp/kill_retry_$$.txt
