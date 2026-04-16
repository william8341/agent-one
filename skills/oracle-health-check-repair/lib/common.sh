#!/usr/bin/env bash
#
# Common functions for Oracle Health Check
#

# Colors
export RED='\033[0;31m'
export GREEN='\033[0;32m'
export YELLOW='\033[0;33m'
export BLUE='\033[0;34m'
export NC='\033[0m'

# Default Oracle Home
DEFAULT_ORACLE_HOME="/Users/shangweilie/downloads/instantclient_23_3"

# Get script directory
get_script_dir() {
    local source="${BASH_SOURCE[0]}"
    while [[ -h "$source" ]]; do
        local dir="$(cd -P "$(dirname "$source")" && pwd)"
        source="$(readlink "$source")"
        [[ $source != /* ]] && source="$dir/$source"
    done
    echo "$(cd -P "$(dirname "$source")" && pwd)"
}

# Get keychain password
get_keychain_password() {
    local service_name="$1"
    security find-generic-password -s "$service_name" -w 2>/dev/null || echo ""
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Generate timestamp
get_timestamp() {
    date "+%Y-%m-%d %H:%M:%S"
}

# Generate JSON timestamp
get_json_timestamp() {
    date "+%Y-%m-%dT%H:%M:%S"
}

# Create lock file
create_lock() {
    local lock_file="$1"
    if [[ -f "$lock_file" ]]; then
        return 1
    fi
    echo $$ > "$lock_file"
    return 0
}

# Remove lock file
remove_lock() {
    local lock_file="$1"
    rm -f "$lock_file"
}

# Ensure directory exists
ensure_dir() {
    local dir="$1"
    mkdir -p "$dir"
}

# Print info message
info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

# Print success message
success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

# Print warning message
warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

# Print error message
error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Load configuration
load_config() {
    local config_file="$1"
    if [[ -f "$config_file" ]]; then
        cat "$config_file"
    else
        echo "{}"
    fi
}

# Get config value
get_config() {
    local config_file="$1"
    local key="$2"
    local default="$3"
    
    if [[ -f "$config_file" ]]; then
        local value=$(jq -r ".$key // \"$default\"" "$config_file" 2>/dev/null)
        echo "$value"
    else
        echo "$default"
    fi
}
