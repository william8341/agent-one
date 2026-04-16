#!/usr/bin/env python3
"""
Oracle 执行计划获取工具
用于获取 SQL 执行计划，供 LLM 分析性能问题
"""

import os
import sys
import json
import argparse
import time
import subprocess
import re

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


def execute_sql(name, sql):
    """通过 SSH 执行 SQL"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]
    oracle_sid = creds["sid"]
    oracle_home = "/u01/app/oracle/product/11.2.0.4/dbhome_1"

    # 清理 SQL - 移除尾部分号和斜杠
    sql_clean = sql.strip().rstrip(";").rstrip("/")

    # 对 SQL 中的单引号进行转义 (Oracle: ' -> '')
    sql_escaped = sql_clean.replace("'", "'\\''")

    # 时间戳
    timestamp = int(time.time())

    # 构建远程 shell 脚本内容
    # 使用 "'" 方式转义单引号
    shell_script = f"""cat > /tmp/run_plan_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
sqlplus -s "/ as sysdba" <<EOFIN
EXPLAIN PLAN FOR {sql_escaped};
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
EOFIN
EOFX
chmod +x /tmp/run_plan_{timestamp}.sh
/tmp/run_plan_{timestamp}.sh
rm -f /tmp/run_plan_{timestamp}.sh
"""

    # 执行远程脚本
    cmd = f"sshpass -p '{ssh_password}' ssh -o StrictHostKeyChecking=no {ssh_user}@{ip} '{shell_script}'"

    try:
        # 执行 SSH 命令
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=120
        )
        output = result.stdout
        error = result.stderr

        if error and "ORA-" in error and "ORA-" not in output:
            return {"status": "error", "message": error}

        return {"status": "success", "plan": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def format_plan_for_llm(plan_text, sql):
    """格式化执行计划，便于 LLM 分析"""
    lines = plan_text.strip().split("\n")

    # 提取关键信息
    sections = {
        "plan": [],
        "notes": [],
    }

    current_section = "plan"
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # 过滤掉常见干扰信息
        if any(
            x in line for x in ["Explained", "SQL*Plus", "Copyright", "Plan hash value"]
        ):
            continue
        if "Note" in line or "---" in line:
            current_section = "notes"
            continue
        sections[current_section].append(line)

    return {
        "sql": sql,
        "plan_text": "\n".join(sections["plan"]),
        "notes": "\n".join(sections["notes"]),
    }


def get_plan_by_sql_id(name, sql_id, child_number=0):
    """通过 SQL_ID 获取执行计划"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]
    oracle_sid = creds["sid"]
    oracle_home = "/u01/app/oracle/product/11.2.0.4/dbhome_1"

    # 转义单引号
    sql_id_escaped = sql_id.replace("'", "'\\''")

    timestamp = int(time.time())

    # 使用 DBMS_XPLAN.DISPLAY_CURSOR 获取执行计划
    # 使用 "'"'"' 方式转义单引号
    shell_script = f"""cat > /tmp/run_plan_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
sqlplus -s "/ as sysdba" <<'EOFIN'
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(sql_id=>'"'"'{sql_id}'"'"', cursor_child_no=>{child_number}, format=>'"'"'ALL -PROJECTION -BYTES'"'"'));
EOFIN
EOFX
chmod +x /tmp/run_plan_{timestamp}.sh
/tmp/run_plan_{timestamp}.sh
rm -f /tmp/run_plan_{timestamp}.sh
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

        return {"status": "success", "plan": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def get_sql_info(name, sql_id):
    """获取 SQL 基本信息"""
    creds = get_credentials(name)
    if not creds:
        return {"status": "error", "message": f"Database {name} not found"}

    ip = creds["ip"]
    ssh_user = creds["os_user"]
    ssh_password = creds["os_password"]

    sql_id_escaped = sql_id.replace("'", "'\\''")
    timestamp = int(time.time())

    shell_script = f"""cat > /tmp/run_plan_{timestamp}.sh << "EOFX"
#!/bin/bash
source ~/.bash_profile 2>/dev/null
sqlplus -s "/ as sysdba" <<'EOFIN'
SET LINESIZE 200
SET PAGESIZE 100
SELECT SQL_ID, CHILD_NUMBER, EXECUTIONS, ELAPSED_TIME/1000000 AS ELAPSED_SEC, 
       CPU_TIME/1000000 AS CPU_SEC, BUFFER_GETS, DISK_READS, ROWS_PROCESSED,
       SUBSTR(SQL_TEXT,1,100) AS SQL_TEXT
FROM V$SQL 
WHERE SQL_ID = '"'"'{sql_id}'"'"'
ORDER BY CHILD_NUMBER;
EOFIN
EOFX
chmod +x /tmp/run_plan_{timestamp}.sh
/tmp/run_plan_{timestamp}.sh
rm -f /tmp/run_plan_{timestamp}.sh
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

        return {"status": "success", "info": output}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def analyze_plan_hints(plan_text):
    """生成分析提示"""
    hints = []

    # 检查常见的性能问题
    if "TABLE ACCESS FULL" in plan_text:
        hints.append("⚠️ 全表扫描 - 建议添加索引")

    if "NESTED LOOP" in plan_text:
        hints.append("ℹ️ 嵌套循环 - 小表驱动大表时效率高")

    if "HASH JOIN" in plan_text:
        hints.append("ℹ️ 哈希连接 - 大表连接时效率高")

    if "MERGE JOIN" in plan_text:
        hints.append("ℹ️ 合并连接 - 需要排好序的数据")

    if "SORT" in plan_text:
        hints.append("⚠️ 排序操作 - 考虑增加 SORT_AREA_SIZE 或添加索引")

    if "INDEX FULL SCAN" in plan_text:
        hints.append("✅ 索引全扫描 - 比全表扫描好")

    if "INDEX RANGE SCAN" in plan_text:
        hints.append("✅ 索引范围扫描 - 高效")

    if "INDEX UNIQUE SCAN" in plan_text:
        hints.append("✅ 索引唯一扫描 - 最优")

    if "REMOTE" in plan_text:
        hints.append("⚠️ 远程操作 - 网络开销大")

    if "PARALLEL" in plan_text:
        hints.append("ℹ️ 并行执行 - 利用多核 CPU")

    return hints


def main():
    parser = argparse.ArgumentParser(description="Oracle 执行计划获取工具")
    parser.add_argument("--name", required=True, help="数据库名称")
    parser.add_argument("--sql", help="SQL 语句 (与 --sql-id 二选一)")
    parser.add_argument("--sql-id", help="SQL ID (从 V$SQL 获取)")
    parser.add_argument("--child", type=int, default=0, help="子游标编号，默认 0")
    parser.add_argument(
        "--format", default="markdown", choices=["markdown", "json", "plain"]
    )
    args = parser.parse_args()

    # 只能选择一种方式
    if not args.sql and not args.sql_id:
        print("ERROR: 必须提供 --sql 或 --sql-id", file=sys.stderr)
        sys.exit(1)

    if args.sql_id:
        # 通过 SQL_ID 获取
        # 先获取 SQL 信息 (可能需要权限)
        info_result = get_sql_info(args.name, args.sql_id)
        # 不强制检查错误，因为 V$SQL 可能需要特殊权限

        # 获取执行计划
        plan_result = get_plan_by_sql_id(args.name, args.sql_id, args.child)
        if plan_result["status"] == "error":
            print(f"ERROR: {plan_result['message']}", file=sys.stderr)
            sys.exit(1)

        # 格式化输出
        plan_text = plan_result["plan"]
        hints = analyze_plan_hints(plan_text)

        sql_info = info_result.get("info", "无法获取 SQL 信息 (可能需要更高权限)")

        if args.format == "json":
            print(
                json.dumps(
                    {
                        "sql_info": sql_info,
                        "plan": plan_text,
                        "hints": hints,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print("## SQL 信息")
            print("```")
            print(sql_info)
            print("```")
            print()
            print("## 执行计划")
            print("```")
            print(plan_text)
            print("```")
            if hints:
                print()
                print("## 分析提示")
                for hint in hints:
                    print(f"- {hint}")
    else:
        # 通过 SQL 文本获取
        result = execute_sql(args.name, args.sql)

        if result["status"] == "error":
            print(f"ERROR: {result['message']}", file=sys.stderr)
            sys.exit(1)

        plan_text = result["plan"]
        formatted = format_plan_for_llm(plan_text, args.sql)
        hints = analyze_plan_hints(plan_text)

        if args.format == "json":
            print(
                json.dumps(
                    {
                        "sql": formatted["sql"],
                        "plan": formatted["plan_text"],
                        "notes": formatted["notes"],
                        "hints": hints,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        elif args.format == "plain":
            print(formatted["plan_text"])
        else:  # markdown
            print("## SQL")
            print("```sql")
            print(formatted["sql"])
            print("```")
            print()
            print("## 执行计划")
            print("```")
            print(formatted["plan_text"])
            print("```")
            if formatted["notes"]:
                print()
                print("## 备注")
                print(formatted["notes"])
            if hints:
                print()
                print("## 分析提示")
                for hint in hints:
                    print(f"- {hint}")


if __name__ == "__main__":
    main()
