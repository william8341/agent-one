#!/usr/bin/env bash

ORACLE_HOME="${ORACLE_HOME:-/Users/shangweilie/downloads/instantclient_23_3}"
export ORACLE_HOME
export TNS_ADMIN="${TNS_ADMIN:-${ORACLE_HOME}/network/admin}"
export PATH="$ORACLE_HOME:$PATH"

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
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local sql="$6"
    
    if [[ -z "$ORACLE_HOME" ]]; then
        ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
    fi
    
    printf "SET HEADING OFF FEEDBACK OFF PAGESIZE 0\n%s\nEXIT\n" "$sql" > /tmp/run_sql.sql
    "$ORACLE_HOME"/sqlplus -s "$user/$pass@$host:$port/$sid as sysdba" @/tmp/run_sql.sql
    rm -f /tmp/run_sql.sql
}

test_connection() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    if [[ -z "$ORACLE_HOME" ]]; then
        ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"
    fi
    
    printf "SET HEADING OFF FEEDBACK OFF PAGESIZE 0\nSELECT 'OK' FROM dual;\nEXIT\n" > /tmp/test_conn.sql
    local result
    result=$("$ORACLE_HOME"/sqlplus -s "$user/$pass@$host:$port/$sid as sysdba" @/tmp/test_conn.sql 2>&1)
    rm -f /tmp/test_conn.sql
    
    if echo "$result" | grep -qE "^OK$"; then
        return 0
    else
        return 1
    fi
}

get_db_role() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result
    result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT database_role FROM v\$database;")
    echo "$result" | grep -E "^(PRIMARY|STANDBY)$" | tr -d ' \r\n'
}

get_db_status() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result
    result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT status FROM v\$instance;")
    echo "$result" | grep -E "^(OPEN|MOUNT)$" | tr -d ' \r\n'
}

run_sql_remote() {
    local host="$1"
    local ssh_user="$2"
    local ssh_key="$3"
    local ssh_pass="$4"
    local sql="$5"
    
    if [[ -n "$ssh_pass" ]]; then
        sshpass -p "$ssh_pass" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${ssh_user}@${host}" "
            source ~/.bash_profile >/dev/null 2>&1
            sqlplus -s '/ as sysdba' << 'EOF'
SET HEADING OFF
$sql
EOF
        " 2>/dev/null
    elif [[ -n "$ssh_key" ]]; then
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$ssh_key" "${ssh_user}@${host}" "
            source ~/.bash_profile >/dev/null 2>&1
            sqlplus -s '/ as sysdba' << 'EOF'
SET HEADING OFF
$sql
EOF
        " 2>/dev/null
    fi
}

get_keychain_password() {
    local keychain_item="$1"
    security find-generic-password -s "$keychain_item" -w 2>/dev/null
}

create_lock() {
    local lock_file="$1"
    if [[ -f "$lock_file" ]]; then
        return 1
    fi
    echo $$ > "$lock_file"
    return 0
}

remove_lock() {
    local lock_file="$1"
    rm -f "$lock_file"
}
