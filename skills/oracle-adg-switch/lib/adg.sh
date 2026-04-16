#!/usr/bin/env bash

check_current_role() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    get_db_role "$user" "$pass" "$host" "$port" "$sid"
}

check_archive_mode() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT log_mode FROM v\$database;")
    echo "$result" | grep -E "^(ARCHIVELOG|NOARCHIVELOG)$" | tr -d ' \r\n'
}

check_db_status() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    get_db_status "$user" "$pass" "$host" "$port" "$sid"
}

check_switchover_status() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT switchover_status FROM v\$database;")
    echo "$result" | tr -d ' \r\n'
}

check_active_transactions() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT COUNT(*) FROM v\$transaction;")
    echo "$result" | tr -d ' \r\n'
}

check_db_status() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    get_db_status "$user" "$pass" "$host" "$port" "$sid"
}

check_switchover_status() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT switchover_status FROM v\$database" 2>&1)
    echo "$result" | tr -d ' \r\n'
}

check_active_transactions() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    
    local result=$(run_sql "$user" "$pass" "$host" "$port" "$sid" "SELECT COUNT(*) FROM v\$transaction" 2>&1)
    echo "$result" | grep -E "^[0-9]+$" | tr -d ' \r\n'
}

check_prerequisites_switchover() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local ssh_user="$6"
    local ssh_key="$7"
    local ssh_pass="$8"
    
    local role=$(check_current_role "$user" "$pass" "$host" "$port" "$sid")
    local arch_mode=$(check_archive_mode "$user" "$pass" "$host" "$port" "$sid")
    local db_status=$(check_db_status "$user" "$pass" "$host" "$port" "$sid")
    local switchover_status=$(check_switchover_status "$user" "$pass" "$host" "$port" "$sid")
    
    cat << EOF
{
  "role": "$role",
  "arch_mode": "$arch_mode",
  "db_status": "$db_status",
  "switchover_status": "$switchover_status"
}
EOF
}

execute_switchover() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local ssh_user="$6"
    local ssh_key="$7"
    local ssh_pass="$8"
    
    local role=$(check_current_role "$user" "$pass" "$host" "$port" "$sid")
    
    if [[ -n "$ssh_pass" || -n "$ssh_key" ]]; then
        if [[ "$role" == "PRIMARY" ]]; then
            run_sql_remote "$host" "$ssh_user" "$ssh_key" "$ssh_pass" "ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY SESSION ALL;"
        else
            run_sql_remote "$host" "$ssh_user" "$ssh_key" "$ssh_pass" "ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN;"
        fi
    else
        if [[ "$role" == "PRIMARY" ]]; then
            run_sql "$user" "$pass" "$host" "$port" "$sid" "ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY SESSION ALL;"
        else
            run_sql "$user" "$pass" "$host" "$port" "$sid" "ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN;"
        fi
    fi
}

execute_failover() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local ssh_user="$6"
    local ssh_key="$7"
    local ssh_pass="$8"
    
    if [[ -n "$ssh_pass" || -n "$ssh_key" ]]; then
        run_sql_remote "$host" "$sid" "$ssh_user" "$ssh_key" "$ssh_pass" "
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;
"
    else
        run_sql "$user" "$pass" "$host" "$port" "$sid" "ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;"
    fi
}

verify_switchover() {
    local user="$1"
    local pass="$2"
    local host="$3"
    local port="$4"
    local sid="$5"
    local expected_role="$6"
    
    sleep 5
    
    local current_role=$(check_current_role "$user" "$pass" "$host" "$port" "$sid")
    local db_status=$(check_db_status "$user" "$pass" "$host" "$port" "$sid")
    
    local verified="false"
    if [[ "$current_role" == "$expected_role" && "$db_status" == "OPEN" ]]; then
        verified="true"
    fi
    
    echo "{\"verified\": $verified, \"role\": \"$current_role\", \"status\": \"$db_status\"}"
}
