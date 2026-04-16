#!/usr/bin/env python3
"""
Oracle SQL 执行工具 - Thin 模式直连（无需 Oracle Client）
"""
import os
import sys
import json
import argparse
import io

# 添加资产管理模块路径
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

try:
    import oracledb
except ImportError:
    print("ERROR: oracledb not installed. Run: pip install oracledb", file=sys.stderr)
    sys.exit(1)

# 导入资产管理模块
sys.path.insert(0, SCRIPT_DIR)
try:
    from oracle_db import get, dsn
except ImportError:
    print("ERROR: oracle_db module not found", file=sys.stderr)
    sys.exit(1)

# 脱敏配置
SENSITIVE_KEYWORDS = [
    'PASSWORD', 'PASSWORD_', 'SECRET', 'CREDENTIAL', 'TOKEN', 
    '_PWD', 'CARD_NO', 'CREDIT_', 'AUTH', 'PRIVATE', 'KEY'
]

def mask_sensitive(value: str) -> str:
    """脱敏处理"""
    return "******"

def should_mask(column_name) -> bool:
    """判断列名是否需要脱敏"""
    if column_name is None:
        return False
    col_upper = str(column_name).upper()
    return any(kw in col_upper for kw in SENSITIVE_KEYWORDS)

def format_table(columns: list, rows: list) -> str:
    """格式化输出为表格"""
    if not columns:
        return "No data"
    
    # 计算每列宽度
    col_widths = [len(str(c)) for c in columns]
    for row in rows:
        for i, cell in enumerate(row):
            if i < len(col_widths):
                col_widths[i] = max(col_widths[i], len(str(cell)))
    
    # 表头
    header = "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(columns)) + " |"
    separator = "|-" + "-|-".join("-" * w for w in col_widths) + "-|"
    
    # 数据行
    data_rows = []
    for row in rows:
        row_str = "| " + " | ".join(str(cell).ljust(col_widths[i]) for i, cell in enumerate(row)) + " |"
        data_rows.append(row_str)
    
    return header + "\n" + separator + "\n" + "\n".join(data_rows)

def execute(name: str, sql: str, user_type: str = "query") -> dict:
    """执行 SQL 并返回结果"""
    try:
        # 获取连接信息
        creds = get(name, user_type)
        dsn_str = dsn(name)
        
        print(f"Connecting to {name} ({dsn_str}) as {user_type}...", file=sys.stderr)
        
        # 连接数据库 (Thin 模式，无需 Oracle Client)
        conn = oracledb.connect(
            user=creds["user"],
            password=creds["password"],
            dsn=dsn_str
        )
        print(f"Connected successfully", file=sys.stderr)
        
        # 执行 SQL
        cursor = conn.cursor()
        cursor.execute(sql)
        
        # 获取列名
        columns = [desc[0] for desc in cursor.description] if cursor.description else []
        
        # 获取数据并进行脱敏
        rows = []
        for row in cursor.fetchall():
            masked_row = []
            for col_name, value in zip(columns, row):
                if should_mask(col_name) and value:
                    masked_row.append(mask_sensitive(str(value)))
                else:
                    masked_row.append(value)
            rows.append(list(masked_row))
        
        result = {
            "status": "success",
            "columns": columns,
            "rows": rows,
            "row_count": cursor.rowcount if hasattr(cursor, 'rowcount') else len(rows),
            "message": "OK"
        }
        
        cursor.close()
        conn.close()
        return result
        
    except oracledb.Error as e:
        error_msg = str(e)
        # 提取 ORA 错误
        if "ORA-" in error_msg:
            lines = error_msg.split('\n')
            for line in lines:
                if "ORA-" in line:
                    return {
                        "status": "error",
                        "columns": [],
                        "rows": [],
                        "row_count": 0,
                        "message": line.strip()
                    }
        return {
            "status": "error",
            "columns": [],
            "rows": [],
            "row_count": 0,
            "message": f"Oracle Error: {error_msg}"
        }
    except Exception as e:
        return {
            "status": "error",
            "columns": [],
            "rows": [],
            "row_count": 0,
            "message": str(e)
        }

def main():
    parser = argparse.ArgumentParser(
        description="Oracle SQL 执行工具 (Thin 模式 - 无需 Oracle Client)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python3 oracle_sql_exec.py --name orcldg --sql "SELECT * FROM v$instance"
  python3 oracle_sql_exec.py --name orclm --sql "SELECT username FROM dba_users" --format json
  python3 oracle_sql_exec.py --name orcldg --sql "SELECT * FROM dba_data_files" --user-type sysdba
        """
    )
    parser.add_argument("--name", required=True, help="数据库名称")
    parser.add_argument("--sql", required=True, help="SQL 语句")
    parser.add_argument(
        "--format", 
        choices=["table", "json", "csv"], 
        default="table", 
        help="输出格式 (默认: table)"
    )
    parser.add_argument(
        "--user-type", 
        choices=["query", "sysdba"], 
        default="query", 
        help="连接类型 (默认: query)"
    )
    parser.add_argument("--export", help="导出到文件")
    parser.add_argument("--commit", action="store_true", help="提交事务")
    parser.add_argument("--rollback", action="store_true", help="回滚事务")
    
    args = parser.parse_args()
    
    result = execute(args.name, args.sql, args.user_type)
    
    if result["status"] == "error":
        print(f"ERROR: {result['message']}", file=sys.stderr)
        sys.exit(1)
    
    if args.export:
        content = format_table(result["columns"], result["rows"])
        with open(args.export, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Exported to {args.export}", file=sys.stderr)
    
    # 输出结果
    if args.format == "json":
        # 自定义 JSON 序列化，处理 list/dict
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    elif args.format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(result["columns"])
        writer.writerows(result["rows"])
        print(output.getvalue())
    else:
        print(format_table(result["columns"], result["rows"]))

if __name__ == "__main__":
    # 添加 csv 导入
    import csv
    main()