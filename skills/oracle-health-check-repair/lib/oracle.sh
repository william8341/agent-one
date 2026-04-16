#!/usr/bin/env bash

ORACLE_HOME="${ORACLE_HOME:-/Users/shangweilie/downloads/instantclient_23_3}"

export TNS_ADMIN="${TNS_ADMIN:-/Users/shangweilie/downloads/instantclient_23_3/network/admin}"
export PATH="$ORACLE_HOME:$PATH"

run_sql() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local sql="$6"
    
    local dsn="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=$host)(PORT=$port))(CONNECT_DATA=(SERVICE_NAME=$sid)))"
    local connect_as=""
    if [[ "$user" == "sys" || "$user" == "SYS" ]]; then
        connect_as="as sysdba"
    fi
    
    echo "SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 32767
$sql
EXIT" | sqlplus -s "$user/$pass@$dsn $connect_as"
}

run_sql_with_header() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local sql="$6"
    
    local dsn="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=$host)(PORT=$port))(CONNECT_DATA=(SERVICE_NAME=$sid)))"
    local connect_as=""
    if [[ "$user" == "sys" || "$user" == "SYS" ]]; then
        connect_as="as sysdba"
    fi
    
    echo "SET HEADING ON FEEDBACK OFF
$sql
EXIT" | sqlplus -s "$user/$pass@$dsn $connect_as"
}

test_connection() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local dsn="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=$host)(PORT=$port))(CONNECT_DATA=(SERVICE_NAME=$sid)))"
    local connect_as=""
    if [[ "$user" == "sys" || "$user" == "SYS" ]]; then
        connect_as="as sysdba"
    fi
    
    local result=$(echo "SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT CHR(79)||CHR(75) FROM dual;
EXIT" | sqlplus -s "$user/$pass@$dsn $connect_as")
    result=$(echo "$result" | tr -d ' \n\r')
    
    if [[ "$result" == "OK" ]]; then
        return 0
    else
        return 1
    fi
}

get_instance_info() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local dsn="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=$host)(PORT=$port))(CONNECT_DATA=(SERVICE_NAME=$sid)))"
    local connect_as=""
    if [[ "$user" == "sys" || "$user" == "SYS" ]]; then
        connect_as="as sysdba"
    fi
    
    echo "SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT instance_name || '|' || version || '|' || status FROM v\$instance;
EXIT" | sqlplus -s "$user/$pass@$dsn $connect_as"
}

get_tablespace_usage() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local threshold="$6"
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT tablespace_name || '|' || ROUND((1 - free_mb / total_mb) * 100, 2)
FROM (
    SELECT a.tablespace_name,
           a.total_mb,
           NVL(b.free_mb, 0) AS free_mb
    FROM (
        SELECT tablespace_name, SUM(bytes)/1024/1024 AS total_mb
        FROM dba_data_files
        GROUP BY tablespace_name
    ) a
    LEFT JOIN (
        SELECT tablespace_name, SUM(bytes)/1024/1024 AS free_mb
        FROM dba_free_space
        GROUP BY tablespace_name
    ) b ON a.tablespace_name = b.tablespace_name
)
WHERE (1 - free_mb / total_mb) * 100 > $threshold
ORDER BY (1 - free_mb / total_mb) * 100 DESC
"
}

get_undo_usage() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local threshold="$6"
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT tablespace_name || '|' || ROUND((used_mb / total_mb) * 100, 2)
FROM (
    SELECT tablespace_name,
           SUM(bytes)/1024/1024 AS total_mb,
           SUM(NVL(used_mb, 0)) AS used_mb
    FROM (
        SELECT tablespace_name, bytes, 0 AS used_mb
        FROM dba_undo_extents
        WHERE status = 'EXPIRED'
        UNION ALL
        SELECT tablespace_name, 0 AS bytes, SUM(bytes)/1024/1024 AS used_mb
        FROM dba_undo_extents
        WHERE status = 'ACTIVE'
        GROUP BY tablespace_name
    )
    GROUP BY tablespace_name
)
WHERE (used_mb / total_mb) * 100 > $threshold
"
}

get_blocking_sessions() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local dsn="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=$host)(PORT=$port))(CONNECT_DATA=(SERVICE_NAME=$sid)))"
    local connect_as=""
    if [[ "$user" == "sys" || "$user" == "SYS" ]]; then
        connect_as="as sysdba"
    fi
    
    echo "SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT a.blocking_session || '|' || b.serial# || '|' || b.username
FROM v\$session a, v\$session b
WHERE a.blocking_session = b.sid
AND b.serial# > 1
AND b.username IS NOT NULL
ORDER BY a.seconds_in_wait DESC;
EXIT" | sqlplus -s "$user/$pass@$dsn $connect_as"
}

get_archive_usage() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local threshold="$6"
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT ROUND((space_used / space_limit) * 100, 2)
FROM v\$recovery_file_dest
WHERE space_limit > 0
"
}

get_invalid_objects() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT owner || '|' || object_type || '|' || COUNT(*)
FROM dba_objects
WHERE status = 'INVALID'
GROUP BY owner, object_type
ORDER BY owner, object_type
"
}

get_alert_errors() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local hours="$6"
    
    local days_ago=$(echo "scale=2; $hours/24" | bc 2>/dev/null || echo "0.1")
    
    local adrci_output
    adrci_output=$(source ~/.bash_profile >/dev/null 2>&1; \
        H=$(adrci exec="show home" 2>/dev/null | grep -i "^${sid}$" | head -1 || \
           adrci exec="show homes" 2>/dev/null | grep -i "$sid" | head -1); \
        if [[ -n "$H" ]]; then \
            adrci exec="set home $H; show alert -p \\"message_text like 'ORA-%' and originating_timestamp > SYSDATE - $days_ago\\"" -term 2>/dev/null; \
        fi)
    
    if [[ -n "$adrci_output" && "$adrci_output" != "No ADR homes found"* ]]; then
        echo "$adrci_output"
        return 0
    fi
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT message_text
FROM X\$DBGALERTEXT
WHERE originating_timestamp > SYSDATE - $hours/24
AND message_text LIKE 'ORA-%'
ORDER BY originating_timestamp DESC
"
}

get_alert_errors_ssh() {
    local host="$1"
    local sid="$2"
    local ssh_user="$3"
    local ssh_key="$4"
    local lines="$5"
    local ssh_pass="$6"
    
    local ssh_cmd
    if [[ -n "$ssh_key" ]]; then
        ssh_cmd="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i '$ssh_key'"
    elif [[ -n "$ssh_pass" ]]; then
        ssh_cmd="sshpass -p '$ssh_pass' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10"
    else
        ssh_cmd="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10"
    fi
    
    $ssh_cmd "${ssh_user}@${host}" "
        source ~/.bash_profile >/dev/null 2>&1
        H=\$(adrci exec=\"show home\" 2>/dev/null | grep -i ${sid} | head -1)
        adrci exec=\"set home \$H; show alert -tail ${lines}\" 2>/dev/null
    " 2>/dev/null | grep -i "ORA-"
}

get_processes_usage() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local threshold="$6"
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT ROUND(current_utilization / limit_value * 100, 2)
FROM v\$resource_limit
WHERE resource_name = 'processes'
AND limit_value > 0
"
}

get_long_running_sessions() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local seconds="$6"
    
    run_sql "$user" "$pass" "$host" "$port" "$sid" "
SELECT sid || '|' || serial# || '|' || username || '|' || seconds_in_wait
FROM v\$session
WHERE status = 'ACTIVE'
AND seconds_in_wait > $seconds
ORDER BY seconds_in_wait DESC
"
}
