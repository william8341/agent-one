#!/usr/bin/env bash

# ADG Switchover 配置加载库

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${SKILL_DIR}/adg_config.conf"

# 检查配置文件是否存在
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Configuration file not found: $CONFIG_FILE"
    exit 1
fi

# 加载配置文件
source "$CONFIG_FILE"

# 导出 ORACLE_HOME
export ORACLE_HOME
export TNS_ADMIN="${ORACLE_HOME}/network/admin"
export PATH="$ORACLE_HOME:$PATH"

# 验证必要的配置项
validate_config() {
    local errors=0
    
    # 检查主库配置
    if [[ -z "$PRIMARY_HOST" ]]; then
        echo "Error: PRIMARY_HOST is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$PRIMARY_SID" ]]; then
        echo "Error: PRIMARY_SID is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$PRIMARY_DB_USER" ]]; then
        echo "Error: PRIMARY_DB_USER is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$PRIMARY_DB_PASS" ]]; then
        echo "Error: PRIMARY_DB_PASS is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$PRIMARY_OS_USER" ]]; then
        echo "Error: PRIMARY_OS_USER is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$PRIMARY_OS_PASS" ]]; then
        echo "Error: PRIMARY_OS_PASS is not set"
        errors=$((errors + 1))
    fi
    
    # 检查备库配置
    if [[ -z "$STANDBY_HOST" ]]; then
        echo "Error: STANDBY_HOST is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$STANDBY_SID" ]]; then
        echo "Error: STANDBY_SID is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$STANDBY_DB_USER" ]]; then
        echo "Error: STANDBY_DB_USER is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$STANDBY_DB_PASS" ]]; then
        echo "Error: STANDBY_DB_PASS is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$STANDBY_OS_USER" ]]; then
        echo "Error: STANDBY_OS_USER is not set"
        errors=$((errors + 1))
    fi
    if [[ -z "$STANDBY_OS_PASS" ]]; then
        echo "Error: STANDBY_OS_PASS is not set"
        errors=$((errors + 1))
    fi
    
    # 检查 Oracle Home
    if [[ -z "$ORACLE_HOME" ]]; then
        echo "Error: ORACLE_HOME is not set"
        errors=$((errors + 1))
    fi
    
    if [[ $errors -gt 0 ]]; then
        return 1
    fi
    return 0
}

# 更新配置文件中的主备角色
update_config_role() {
    local new_primary_sid="$1"
    local new_standby_sid="$2"
    
    # 创建临时文件
    local tmpfile="${CONFIG_FILE}.tmp"
    
    # 更新 CURRENT_PRIMARY_SID 和 CURRENT_STANDBY_SID
    sed -e "s/CURRENT_PRIMARY_SID=\".*\"/CURRENT_PRIMARY_SID=\"${new_primary_sid}\"/" \
        -e "s/CURRENT_STANDBY_SID=\".*\"/CURRENT_STANDBY_SID=\"${new_standby_sid}\"/" \
        "$CONFIG_FILE" > "$tmpfile"
    
    # 替换原文件
    mv "$tmpfile" "$CONFIG_FILE"
    
    # 重新加载配置
    source "$CONFIG_FILE"
}

# 获取主库信息
get_primary_info() {
    echo "PRIMARY_HOST=$PRIMARY_HOST"
    echo "PRIMARY_PORT=$PRIMARY_PORT"
    echo "PRIMARY_SID=$PRIMARY_SID"
    echo "PRIMARY_DB_USER=$PRIMARY_DB_USER"
    echo "PRIMARY_DB_PASS=$PRIMARY_DB_PASS"
    echo "PRIMARY_OS_USER=$PRIMARY_OS_USER"
    echo "PRIMARY_OS_PASS=$PRIMARY_OS_PASS"
}

# 获取备库信息
get_standby_info() {
    echo "STANDBY_HOST=$STANDBY_HOST"
    echo "STANDBY_PORT=$STANDBY_PORT"
    echo "STANDBY_SID=$STANDBY_SID"
    echo "STANDBY_DB_USER=$STANDBY_DB_USER"
    echo "STANDBY_DB_PASS=$STANDBY_DB_PASS"
    echo "STANDBY_OS_USER=$STANDBY_OS_USER"
    echo "STANDBY_OS_PASS=$STANDBY_OS_PASS"
}

# 显示配置信息
show_config() {
    echo "=========================================="
    echo "  Oracle ADG Configuration"
    echo "=========================================="
    echo ""
    echo "Primary:"
    echo "  Host: $PRIMARY_HOST:$PRIMARY_PORT"
    echo "  SID: $PRIMARY_SID"
    echo "  DB User: $PRIMARY_DB_USER"
    echo "  OS User: $PRIMARY_OS_USER"
    echo ""
    echo "Standby:"
    echo "  Host: $STANDBY_HOST:$STANDBY_PORT"
    echo "  SID: $STANDBY_SID"
    echo "  DB User: $STANDBY_DB_USER"
    echo "  OS User: $STANDBY_OS_USER"
    echo ""
    echo "Current Topology:"
    echo "  Primary SID: $CURRENT_PRIMARY_SID"
    echo "  Standby SID: $CURRENT_STANDBY_SID"
    echo ""
    echo "Config:"
    echo "  Oracle Home: $ORACLE_HOME"
    echo "  SQL Timeout: $SQL_TIMEOUT"
    echo "  SSH Timeout: $SSH_TIMEOUT"
}
