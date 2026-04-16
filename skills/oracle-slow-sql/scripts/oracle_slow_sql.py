#!/usr/bin/env python3
"""
Oracle 慢 SQL 查询工具
用于查询当前或历史慢 SQL，供 LLM 分析性能问题
"""

import os
import sys
import json
import argparse
import time
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)

# 添加 oracle_db 模块路径
sys.path.insert(0, os.path.expanduser("~/.opencode/skills/oracle-db/scripts"))
from oracle_db import decrypt, load_assets


def get_credentials(name):
    """获取数据库凭据"""
    assets = load_assets()
    for inst in assets.get("instances", []):
        if inst["name"] == name:
            return {
                "ip": inst["ip"],
                "sid": inst.get("sid", name),
                "os_user": inst["os_user"],
                "os_password": decrypt(inst.get("os_password", "")),
                "os_ssh_port": inst.get("os_ssh_port", 22),
            }
    return None


def query_slow_sql(name, seconds=5, limit=20):
    """查询慢 SQL"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]
    oracle_sid = creds["sid"]

    timestamp = int(time.time())

    # 查询当前慢 SQL (V$SQL) - 使用 printf 方式
    sql_query = f"""
SET LINESIZE 300
SET PAGESIZE 100
SELECT * FROM (
  SELECT SQL_ID, CHILD_NUMBER, EXECUTIONS,
         ROUND(ELAPSED_TIME/1000000, 2) AS ELAPSED_SEC,
         ROUND(CPU_TIME/1000000, 2) AS CPU_SEC,
         BUFFER_GETS, DISK_READS, ROWS_PROCESSED,
         SUBSTR(SQL_TEXT,1,80) AS SQL_TEXT
  FROM V\\$SQL 
  WHERE ELAPSED_TIME > {seconds}*1000000
  ORDER BY ELAPSED_TIME DESC
) WHERE ROWNUM <= {limit};
EXIT
"""
    shell_script = f"""cat > /tmp/slow_sql_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
printf '{sql_query}' | /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s "/ as sysdba"
EOFX
chmod +x /tmp/slow_sql_{timestamp}.sh
/tmp/slow_sql_{timestamp}.sh
rm -f /tmp/slow_sql_{timestamp}.sh
"""

    cmd = f"sshpass -p '{ssh_password}' ssh -o StrictHostKeyChecking=no {ssh_user}@{ip} '{shell_script}'"

    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=180
        )
        output = result.stdout
        error = result.stderr

        if error and "ORA-" in error and "ORA-" not in output:
            return {"status": "error", "message": error}

        return {"status": "success", "data": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def query_session_sql(name, sid=None, serial=None):
    """查询指定会话的 SQL"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]

    timestamp = int(time.time())

    if sid and serial:
        where_clause = f"s.SID = {sid} AND s.SERIAL# = {serial}"
    else:
        where_clause = "s.STATUS = ''ACTIVE'' AND s.LAST_CALL_ET > 10"

    sql_query = f"""SET LINESIZE 300
COLUMN sql_text FORMAT A100

SELECT 
    s.SID,
    s.SERIAL#,
    s.USERNAME,
    s.STATUS,
    s.LAST_CALL_ET AS SECONDS,
    s.SQL_ID,
    s.SQL_CHILD_NUMBER,
    (SELECT SUBSTR(SQL_TEXT,1,100) FROM V\\$SQL q WHERE q.SQL_ID = s.SQL_ID AND q.CHILD_NUMBER = s.SQL_CHILD_NUMBER AND ROWNUM = 1) AS SQL_TEXT
FROM V\\$SESSION s
WHERE {where_clause}
ORDER BY s.LAST_CALL_ET DESC;
EXIT
"""
    shell_script = f"""cat > /tmp/sess_sql_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
printf '{sql_query}' | /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s "/ as sysdba"
EOFX
chmod +x /tmp/sess_sql_{timestamp}.sh
/tmp/sess_sql_{timestamp}.sh
rm -f /tmp/sess_sql_{timestamp}.sh
"""

    cmd = f"sshpass -p '{ssh_password}' ssh -o StrictHostKeyChecking=no {ssh_user}@{ip} '{shell_script}'"

    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=120
        )
        output = result.stdout
        error = result.stderr

        if error and "ORA-" in error and "ORA-" not in output:
            return {"status": "error", "message": error}

        return {"status": "success", "data": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def query_long_ops(name, seconds=10, limit=20):
    """查询长时间运行的操作"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]

    timestamp = int(time.time())

    sql_query = f"""SET LINESIZE 300
COLUMN sql_text FORMAT A80
COLUMN message FORMAT A50

SELECT * FROM (
SELECT 
    SID,
    SERIAL#,
    USERNAME,
    OPNAME,
    TARGET,
    ROUND(TIME_REMAINING/60,1) AS MINUTES_REMAINING,
    ROUND(ELAPSED_SECONDS/60,1) AS MINUTES_ELAPSED,
    MESSAGE,
    SQL_ID
FROM V\\$SESSION_LONGOPS
WHERE TIME_REMAINING > 0
    OR ELAPSED_SECONDS > {seconds}
ORDER BY START_TIME DESC
) WHERE ROWNUM <= {limit};
EXIT
"""
    shell_script = f"""cat > /tmp/long_ops_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
printf '{sql_query}' | /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s "/ as sysdba"
EOFX
chmod +x /tmp/long_ops_{timestamp}.sh
/tmp/long_ops_{timestamp}.sh
rm -f /tmp/long_ops_{timestamp}.sh
"""

    cmd = f"sshpass -p '{ssh_password}' ssh -o StrictHostKeyChecking=no {ssh_user}@{ip} '{shell_script}'"

    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=120
        )
        output = result.stdout
        error = result.stderr

        if error and "ORA-" in error and "ORA-" not in output:
            return {"status": "error", "message": error}

        return {"status": "success", "data": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def query_sql_history(name, minutes=30, limit=20):
    """查询历史 SQL (AWR)"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]

    timestamp = int(time.time())

    # 首先检查 AWR 许可
    min_seconds = 5  # 默认最小5秒
    # Oracle 11g compatible: SYSDATE - minutes/(24*60)
    sql_query = f"""SET LINESIZE 300
COLUMN sql_text FORMAT A80

SELECT * FROM (
SELECT 
    SQL_ID,
    SUM(EXECUTIONS) AS EXECS,
    ROUND(SUM(ELAPSED_TIME)/1000000, 2) AS TOTAL_SEC,
    ROUND(SUM(CPU_TIME)/1000000, 2) AS TOTAL_CPU_SEC,
    SUM(BUFFER_GETS) AS BUFFER_GETS,
    SUM(DISK_READS) AS DISK_READS,
    ROUND(AVG(BUFFER_GETS/DECODE(ROWS_PROCESSED,0,1,ROWS_PROCESSED)),2) AS AVG_GETS_PER_ROW,
    SUBSTR(MAX(SQL_TEXT),1,80) AS SQL_TEXT
FROM DBA_HIST_SQLSTAT h, DBA_HIST_SNAPSHOT s
WHERE h.SNAP_ID = s.SNAP_ID
    AND s.BEGIN_INTERVAL_TIME > SYSDATE - {minutes}/(24*60)
    AND h.ELAPSED_TIME > {min_seconds}*1000000
GROUP BY SQL_ID
ORDER BY SUM(ELAPSED_TIME) DESC
) WHERE ROWNUM <= {limit};
EXIT
"""
    shell_script = f"""cat > /tmp/awr_sql_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
printf '{sql_query}' | /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s "/ as sysdba"
EOFX
chmod +x /tmp/awr_sql_{timestamp}.sh
/tmp/awr_sql_{timestamp}.sh
rm -f /tmp/awr_sql_{timestamp}.sh
"""

    cmd = f"sshpass -p '{ssh_password}' ssh -o StrictHostKeyChecking=no {ssh_user}@{ip} '{shell_script}'"

    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=180
        )
        output = result.stdout
        error = result.stderr

        if error and "ORA-" in error and "ORA-" not in output:
            # 可能没有 AWR 许可，返回简化信息
            return {"status": "error", "message": "AWR 不可用或无权限: " + error}

        return {"status": "success", "data": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def analyze_wait_events(name, limit=20):
    """查询等待事件"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]

    timestamp = int(time.time())

    sql_query = f"""SET LINESIZE 300

SELECT * FROM (
SELECT 
    s.SID,
    s.USERNAME,
    s.STATUS,
    w.EVENT,
    w.WAIT_TIME,
    w.SECONDS_IN_WAIT,
    w.STATE,
    s.SQL_ID
FROM V\\$SESSION_WAIT w, V\\$SESSION s
WHERE w.SID = s.SID
    AND s.STATUS = ''ACTIVE''
ORDER BY w.SECONDS_IN_WAIT DESC
) WHERE ROWNUM <= {limit};
EXIT
"""
    shell_script = f"""cat > /tmp/wait_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
printf '{sql_query}' | /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s "/ as sysdba"
EOFX
chmod +x /tmp/wait_{timestamp}.sh
/tmp/wait_{timestamp}.sh
rm -f /tmp/wait_{timestamp}.sh
"""

    cmd = f"sshpass -p '{ssh_password}' ssh -o StrictHostKeyChecking=no {ssh_user}@{ip} '{shell_script}'"

    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=120
        )
        output = result.stdout
        error = result.stderr

        if error and "ORA-" in error and "ORA-" not in output:
            return {"status": "error", "message": error}

        return {"status": "success", "data": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def format_output(title, data):
    """格式化输出"""
    lines = data.strip().split("\n")
    filtered = []
    for line in lines:
        if any(
            x in line
            for x in ["SQL>", "Connected", "Copyright", "rows selected", "no rows"]
        ):
            continue
        filtered.append(line)

    result = "\n".join(filtered)
    if not result.strip():
        return "无数据"
    return result


def main():
    parser = argparse.ArgumentParser(description="Oracle 慢 SQL 查询工具")
    parser.add_argument("--name", required=True, help="数据库名称")
    parser.add_argument(
        "--mode",
        default="slow",
        choices=["slow", "session", "longops", "awr", "wait"],
        help="查询模式",
    )
    parser.add_argument("--seconds", type=int, default=5, help="慢 SQL 阈值(秒)")
    parser.add_argument(
        "--minutes", type=int, default=30, help="历史查询时间范围(分钟)"
    )
    parser.add_argument("--limit", type=int, default=20, help="返回行数")
    parser.add_argument("--sid", type=int, help="会话 SID")
    parser.add_argument("--serial", type=int, help="会话 SERIAL#")
    parser.add_argument(
        "--format", default="markdown", choices=["markdown", "json", "plain"]
    )
    args = parser.parse_args()

    # 执行查询
    if args.mode == "slow":
        result = query_slow_sql(args.name, args.seconds, args.limit)
        title = f"慢 SQL 查询 (耗时 > {args.seconds} 秒)"
    elif args.mode == "session":
        result = query_session_sql(args.name, args.sid, args.serial)
        title = "活动会话 SQL"
    elif args.mode == "longops":
        result = query_long_ops(args.name, args.seconds, args.limit)
        title = f"长时间运行操作 (> {args.seconds} 秒)"
    elif args.mode == "awr":
        result = query_sql_history(args.name, args.minutes, args.limit)
        title = f"历史 SQL (最近 {args.minutes} 分钟)"
    elif args.mode == "wait":
        result = analyze_wait_events(args.name, args.limit)
        title = "当前等待事件"
    else:
        result = {"status": "error", "message": "未知模式"}
        title = "错误"

    if result["status"] == "error":
        print(f"ERROR: {result['message']}", file=sys.stderr)
        sys.exit(1)

    output = format_output(title, result["data"])

    if args.format == "json":
        print(
            json.dumps(
                {
                    "title": title,
                    "data": output,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(f"## {title}")
        print("```")
        print(output)
        print("```")


if __name__ == "__main__":
    main()
