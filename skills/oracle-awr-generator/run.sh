#!/usr/bin/env bash

# Oracle AWR Report Generator for LLM Analysis
# Generates AWR reports and prepares them for AI/LLM analysis

set -euo pipefail

ORACLE_HOME="${ORACLE_HOME:-/Users/shangweilie/downloads/instantclient_23_3}"
export ORACLE_HOME
export PATH="$ORACLE_HOME:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR"
LIB_DIR="$SCRIPT_DIR/lib"
OUTPUT_DIR="$SKILL_DIR/output"
ORACLE_DB_SCRIPT="$HOME/.opencode/skills/oracle-db/scripts/oracle_db.py"

# Default values
DB_NAME=""
HOST=""
PORT="1521"
USER=""
PASS=""
SID=""
KEYCHAIN=""
HOURS_BACK=${HOURS_BACK:-1}  # Default: last 1 hour
REPORT_TYPE=${REPORT_TYPE:-TEXT}  # TEXT or HTML
FORMAT=${FORMAT:-SHORT}  # SHORT or FULL

show_help() {
    cat << 'EOF'
Oracle AWR Report Generator for LLM Analysis

Usage: run.sh [OPTIONS]

Options:
  -n, --db-name NAME     Database name in oracle-db inventory
  -H, --host HOST        Oracle host
  -P, --port PORT        Oracle port (default: 1521)
  -u, --user USER        Database user (must have DBA privileges)
  -p, --password PASS    Database password
  -s, --sid SID          Oracle SID
  -k, --keychain NAME   Mac Keychain item (format: user@host:sid)
  -h, --hours-back HOURS Hours to look back (default: 1)
  -t, --type TYPE       Report type: TEXT or HTML (default: TEXT)
  -f, --format FORMAT   Report format: SHORT or FULL (default: SHORT)
  --oracle-home PATH    Oracle Instant Client path
  -h, --help            Show this help

Examples:
  # Generate report for last hour using oracle-db asset
  ./run.sh -n orclm
  
  # Generate report for last 2 hours
  ./run.sh -n orclm -h 2
  
  # Generate HTML report
  ./run.sh -n orclm -t HTML
  
  # Manual connection
  ./run.sh -H 192.168.1.100 -u system -p password -s orcl
  
  # Using keychain
  ./run.sh -k "system@192.168.1.100:orcl"

Output:
  - AWR report saved to output/ directory
  - Summary printed to stdout for quick review
  - Formatted for LLM analysis

EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -H|--host) HOST="$2"; shift 2 ;;
            -P|--port) PORT="$2"; shift 2 ;;
            -u|--user) USER="$2"; shift 2 ;;
            -p|--password) PASS="$2"; shift 2 ;;
            -s|--sid) SID="$2"; shift 2 ;;
            -n|--db-name) DB_NAME="$2"; shift 2 ;;
            -k|--keychain) KEYCHAIN="$2"; shift 2 ;;
            -h|--hours-back) HOURS_BACK="$2"; shift 2 ;;
            -t|--type) REPORT_TYPE="$2"; shift 2 ;;
            -f|--format) FORMAT="$2"; shift 2 ;;
            --oracle-home) ORACLE_HOME="$2"; shift 2 ;;
            -h|--help) show_help; exit 0 ;;
            *) echo "Unknown: $1"; show_help; exit 1 ;;
        esac
    done
}

load_from_oracle_db() {
    local db_name="$1"
    if [[ ! -f "$ORACLE_DB_SCRIPT" ]]; then
        echo "Error: oracle-db script not found: $ORACLE_DB_SCRIPT"
        return 1
    fi
    
    local conn_info
    conn_info=$(python3 "$ORACLE_DB_SCRIPT" query --name "$db_name" 2>/dev/null)
    if [[ $? -ne 0 || -z "$conn_info" ]]; then
        echo "Error: Database not found in oracle-db: $db_name"
        return 1
    fi
    
    HOST=$(echo "$conn_info" | grep "地址:" | sed 's/.*地址: *//' | cut -d: -f1)
    PORT=$(echo "$conn_info" | grep "地址:" | sed 's/.*地址: *//' | cut -d: -f2)
    SID=$(echo "$conn_info" | grep "SID:" | sed 's/.*SID: *//')
    
    # Use SYSDBA for AWR
    PASS=$(python3 -c "
import sys
sys.path.insert(0, '$HOME/.opencode/skills/oracle-db/scripts')
from oracle_db import get
info = get('$db_name', 'sysdba')
print(info.get('password',''))
" 2>/dev/null)
    
    USER="sys"
    
    if [[ -z "$HOST" || -z "$SID" || -z "$PASS" ]]; then
        echo "Error: Failed to load connection info from oracle-db"
        return 1
    fi
    
    echo "Loaded from oracle-db: $db_name -> $HOST/$SID"
    return 0
}

if [[ $# -eq 0 ]]; then
    show_help
    exit 0
fi

parse_args "$@"

if [[ -n "$KEYCHAIN" ]]; then
    PASS=$(security find-internet-password -s "$KEYCHAIN" -w 2>/dev/null || echo "")
    USER=$(echo "$KEYCHAIN" | cut -d'@' -f1)
    HOST=$(echo "$KEYCHAIN" | cut -d'@' -f2 | cut -d':' -f1)
    SID=$(echo "$KEYCHAIN" | cut -d':' -f2)
fi

if [[ -n "$DB_NAME" ]]; then
    if ! load_from_oracle_db "$DB_NAME"; then
        exit 1
    fi
fi

if [[ -z "$HOST" || -z "$USER" || -z "$PASS" || -z "$SID" ]]; then
    echo "Error: Missing required parameters"
    show_help
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_EXT=$(echo "$REPORT_TYPE" | tr '[:upper:]' '[:lower:]')
OUTPUT_FILE="$OUTPUT_DIR/awr_${SID}_${TIMESTAMP}.${REPORT_EXT}"

echo "============================================"
echo "Oracle AWR Report Generator"
echo "============================================"
echo "Database: $SID ($HOST:$PORT)"
echo "User: $USER"
echo "Hours Back: $HOURS_BACK"
echo "Report Type: $REPORT_TYPE"
echo "Format: $FORMAT"
echo "============================================"
echo ""

# Build connection string
CONN_STR="${USER}/${PASS}@${HOST}:${PORT}/${SID}"

# Get DBID
echo "Getting DBID..."
DBID=$(sqlplus -s "$CONN_STR as sysdba" << 'SQL'
SET HEADING OFF FEEDBACK OFF
SELECT dbid FROM v$database;
EXIT;
SQL
)
DBID=$(echo "$DBID" | tr -d ' \n')

echo "DBID: $DBID"

# Get instance number
INST_NUM=$(sqlplus -s "$CONN_STR as sysdba" << 'SQL'
SET HEADING OFF FEEDBACK OFF
SELECT instance_number FROM v$instance;
EXIT;
SQL
)
INST_NUM=$(echo "$INST_NUM" | tr -d ' \n')

echo "Instance: $INST_NUM"
echo ""

# Get snap IDs for the time range
echo "Finding snapshots for last ${HOURS_BACK} hour(s)..."

SNAP_INFO=$(sqlplus -s "$CONN_STR as sysdba" << 'SQL'
SET HEADING OFF FEEDBACK OFF
SELECT snap_id || '|' || TO_CHAR(begin_interval_time, 'YYYY-MM-DD HH24:MI')
FROM dba_hist_snapshot
WHERE begin_interval_time >= SYSDATE - 1
ORDER BY snap_id DESC;
EXIT;
SQL
)

SNAP_IDS=$(echo "$SNAP_INFO" | grep "^[0-9]" | cut -d'|' -f1)

if [[ -z "$SNAP_IDS" ]]; then
    echo "Error: No snapshots found for the specified time range"
    echo "Please ensure AWR is configured and snapshots exist"
    exit 1
fi

# Get two consecutive snapshots (AWR needs begin < end)
SNAP_LIST=$(echo "$SNAP_IDS" | grep "^[0-9]" | sort -n | head -2)
BEGIN_SNAP=$(echo "$SNAP_LIST" | head -1)
END_SNAP=$(echo "$SNAP_LIST" | tail -1)

if [[ -z "$END_SNAP" || -z "$BEGIN_SNAP" ]]; then
    echo "Error: Not enough snapshots found"
    exit 1
fi

if [[ -z "$END_SNAP" ]]; then
    END_SNAP=$BEGIN_SNAP
fi

echo "Found snapshots:"
echo "  Begin Snap: $BEGIN_SNAP"
echo "  End Snap: $END_SNAP"
echo ""

# Generate AWR report
echo "Generating AWR report..."

if [[ "$REPORT_TYPE" == "HTML" ]]; then
    REPORT_FUNC="DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML"
else
    REPORT_FUNC="DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_TEXT"
fi

# Generate report based on format
if [[ "$FORMAT" == "FULL" ]]; then
    FORMAT_STR="ALL"
else
    FORMAT_STR="TYPICAL"
fi

# Generate the report
sqlplus -s "$CONN_STR as sysdba" << SQL > "$OUTPUT_FILE"
SET LINESIZE 200
SET PAGESIZE 0
SET HEADING OFF
SET FEEDBACK OFF
SET VERIFY OFF

SELECT output
FROM TABLE(
  $REPORT_FUNC(
    l_dbid      => $DBID,
    l_inst_num  => $INST_NUM,
    l_bid       => $BEGIN_SNAP,
    l_eid       => $END_SNAP
  )
);

EXIT;
SQL

# Check if report was generated
if [[ ! -s "$OUTPUT_FILE" ]]; then
    echo "Error: Failed to generate AWR report"
    exit 1
fi

# Remove empty lines and ANSI codes
sed -i '' 's/^[[:space:]]*$//' "$OUTPUT_FILE" 2>/dev/null || true
sed -i '' 's/\\//g' "$OUTPUT_FILE" 2>/dev/null || true

echo "============================================"
echo "AWR Report Generated Successfully!"
echo "============================================"
echo "Output File: $OUTPUT_FILE"
echo ""

# Print summary
echo "=== Report Summary ==="
echo ""

if [[ "$REPORT_TYPE" == "HTML" ]]; then
    echo "HTML report generated. Open in browser for full formatting."
    echo ""
    echo "Key sections to analyze:"
    echo "  - Load Profile"
    echo "  - Top 10 Foreground Wait Events"
    echo "  - SQL Statistics"
    echo "  - Instance Efficiency Percentages"
else
    # Extract key sections for quick review
    echo "--- Load Profile ---"
    grep -A 20 "^Load Profile" "$OUTPUT_FILE" | head -25 || echo "(Section not found)"
    
    echo ""
    echo "--- Top Wait Events ---"
    grep -A 15 "^Top 10 Foreground Wait Events" "$OUTPUT_FILE" | head -20 || echo "(Section not found)"
    
    echo ""
    echo "--- Top SQL ---"
    grep -A 10 "^SQL ordered by Elapsed Time" "$OUTPUT_FILE" | head -15 || echo "(Section not found)"
    
    echo ""
    echo "--- Instance Efficiency ---"
    grep -A 15 "^Instance Efficiency Percentages" "$OUTPUT_FILE" | head -20 || echo "(Section not found)"
fi

echo ""
echo "============================================"
echo "For LLM Analysis:"
echo "  Full report saved to: $OUTPUT_FILE"
echo "  Use the content of this file for AI analysis"
echo "============================================"
