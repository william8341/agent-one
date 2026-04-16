#!/usr/bin/env bash

format_result_json() {
    local operation="$1"
    local status="$2"
    local before_role="$3"
    local after_role="$4"
    local steps_json="$5"
    local message="$6"
    
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    echo "{\"operation\":\"$operation\",\"status\":\"$status\",\"timestamp\":\"$timestamp\",\"before\":{\"role\":\"$before_role\"},\"after\":{\"role\":\"$after_role\"},\"steps\":$steps_json,\"message\":\"$message\"}"
}

format_step_json() {
    local step="$1"
    local status="$2"
    local message="$3"
    
    local escaped_msg=$(echo "$message" | tr '\n\r' '  ' | sed 's/"/\\"/g')
    echo "{\"step\":\"$step\",\"status\":\"$status\",\"message\":\"$escaped_msg\"}"
}

format_result_md() {
    local operation="$1"
    local status="$2"
    local before_role="$3"
    local after_role="$4"
    local message="$5"
    
    local status_icon="✅"
    [[ "$status" != "SUCCESS" ]] && status_icon="❌"
    
    cat << EOF
# Oracle ADG Switch Report

**Operation**: $operation  
**Status**: $status_icon $status  
**Time**: $(date +"%Y-%m-%d %H:%M:%S")

## Role Change

- Before: $before_role
- After: $after_role

## Message

$message
EOF
}
