#!/usr/bin/env python3
"""
Oracle SQL 执行工具 - SSH + SQLPlus 模式
"""

import os
import sys
import json
import argparse
import time
import select

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# 导入 oracle_db 模块
from oracle_db import decrypt, load_assets

SENSITIVE_KEYWORDS = [
    "PASSWORD",
    "PASSWORD_",
    "SECRET",
    "CREDENTIAL",
    "TOKEN",
    "_PWD",
    "CARD_NO",
]


def mask_sensitive(val):
    return "******"


def should_mask(col):
    if col is None:
        return False
    return any(kw in str(col).upper() for kw in SENSITIVE_KEYWORDS)


def format_table(columns, rows):
    if not columns:
        return "No data"
    if not rows:
        return "Query returned no rows"
    ws = [len(str(c)) for c in columns]
    for row in rows:
        for i, v in enumerate(row):
            if i < len(ws):
                ws[i] = max(ws[i], len(str(v)))
    header = (
        "| " + " | ".join(str(c).ljust(ws[i]) for i, c in enumerate(columns)) + " |"
    )
    sep = "|-" + "-|-".join("-" * w for w in ws) + "-|"
    data_rows = []
    for row in rows:
        cells = []
        for i, v in enumerate(row):
            if i < len(ws):
                cells.append(str(v).ljust(ws[i]))
        data_rows.append("| " + " | ".join(cells) + " |")
    return header + "\n" + sep + "\n" + "\n".join(data_rows)


def parse_output(output):
    """解析 SQLPlus 输出"""
    lines = [l.strip() for l in output.strip().split("\n") if l.strip()]
    filtered = []
    for l in lines:
        if any(
            x in l
            for x in [
                "SQL*Plus",
                "Copyright",
                "All rights",
                "Usage:",
                "Connected",
                "Oracle",
            ]
        ):
            continue
        if l.startswith("SQL>"):
            continue
        if "SP2-" in l or "ORA-" in l:
            filtered.append(l)
            continue
        if l == "no rows selected" or l == "无行被选中":
            continue
        filtered.append(l)

    if not filtered:
        return {"columns": [], "rows": [], "message": ""}

    errors = [l for l in filtered if "ORA-" in l or "SP2-" in l]
    if errors:
        return {"columns": [], "rows": [], "message": "\n".join(errors)}

    sep = -1
    for i, l in enumerate(filtered):
        if all(c in "-=+ " for c in l):
            sep = i
            break

    cols, rows = [], []
    if sep > 0:
        cols = filtered[sep - 1].split()
    for l in filtered[sep + 1 :]:
        vals = l.split()
        if vals:
            mask = [
                mask_sensitive(v)
                if should_mask(cols[j] if j < len(cols) else "")
                else v
                for j, v in enumerate(vals)
            ]
            rows.append(mask)

    return {"columns": cols, "rows": rows}


def execute(name, sql):
    try:
        # 从 assets 文件读取并解密密码
        assets = load_assets()

        db = None
        for inst in assets.get("instances", []):
            if inst["name"] == name:
                db = inst
                break

        if not db:
            return {
                "status": "error",
                "columns": [],
                "rows": [],
                "row_count": 0,
                "message": f"Database {name} not found",
            }

        ip = db["ip"]
        ssh_user = db["os_user"]
        ssh_password = decrypt(db.get("os_password", ""))
        oracle_sid = db.get("sid", name)
        oracle_home = "/u01/app/oracle/product/11.2.0.4/dbhome_1"

        print(f"SSH to {ip}...", file=sys.stderr)

        # 使用 subprocess + sshpass
        import subprocess

        # 清理 SQL - 移除尾部分号和斜杠
        sql_clean = sql.strip().rstrip(";").rstrip("/")

        # 构建命令 - 使用大括号组合 + echo 管道
        ssh_cmd = f'{{ source ~/.bash_profile 2>/dev/null; echo -e "{sql_clean};\\nEXIT;" | /u01/app/oracle/product/11.2.0.4/dbhome_1/bin/sqlplus -s "/ as sysdba"; }}'

        cmd = [
            "sshpass",
            "-p",
            ssh_password,
            "ssh",
            "-o",
            "StrictHostKeyChecking=no",
            f"{ssh_user}@{ip}",
            ssh_cmd,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        output = result.stdout
        error = result.stderr

        # 解析输出
        parsed = parse_output(output)

        if parsed.get("message"):
            return {
                "status": "error",
                "columns": [],
                "rows": [],
                "row_count": 0,
                "message": parsed["message"],
            }

        return {
            "status": "success",
            "columns": parsed.get("columns", []),
            "rows": parsed.get("rows", []),
            "row_count": len(parsed.get("rows", [])),
            "message": "OK",
        }

    except Exception as e:
        return {
            "status": "error",
            "columns": [],
            "rows": [],
            "row_count": 0,
            "message": str(e),
        }


def main():
    p = argparse.ArgumentParser(description="Oracle SQL via SSH")
    p.add_argument("--name", required=True, help="DB name")
    p.add_argument("--sql", required=True, help="SQL")
    p.add_argument("--format", default="table", choices=["table", "json"])
    a = p.parse_args()

    r = execute(a.name, a.sql)
    if r["status"] == "error":
        print(f"ERROR: {r['message']}", file=sys.stderr)
        sys.exit(1)

    if a.format == "json":
        print(json.dumps(r, ensure_ascii=False, indent=2, default=str))
    else:
        print(format_table(r["columns"], r["rows"]))


if __name__ == "__main__":
    main()
