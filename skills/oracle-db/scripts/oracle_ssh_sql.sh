#!/bin/bash
# Oracle SQL SSH Execution Script

# Usage: ./oracle_ssh_sql.sh <host> <password> <sql>

HOST="$1"
PASSWORD="$2"
SQL="$3"

# Write SQL to remote file
sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no oracle@$HOST "cat > /home/oracle/sql.txt << 'EOFSQL'
$SQL
EOFSQL" 2>/dev/null

# Run sqlplus and capture output
sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no oracle@$HOST "bash -c 'source ~/.bash_profile 2>/dev/null; /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s / as sysdba' < /home/oracle/sql.txt" 2>/dev/null
