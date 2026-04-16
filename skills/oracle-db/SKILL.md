---
name: oracle-db
description: 管理 Oracle 数据库资产清单，查询、添加、更新、删除数据库连接信息。当用户提到 Oracle 数据库、数据库资产、数据库连接时使用。
allowed-tools: Bash(python3 ~/.claude/skills/oracle-db/scripts/*)
---

# Oracle 数据库资产管理 Skill

## 概述

管理 Oracle 数据库资产清单，存储连接凭据和 ADG 信息。密码使用 Fernet 加密存储。

## 文件位置

```
~/.claude/skills/oracle-db/
├── SKILL.md
├── scripts/oracle_db.py
├── oracle_assets.json    # 资产数据
└── .vault_key            # 加密密钥
```

## 快速查看（直接运行，不经 LLM）

```bash
python3 ~/.claude/skills/oracle-db/scripts/oracle_db.py query --all
```

## CLI 命令

```bash
SCRIPT=~/.claude/skills/oracle-db/scripts/oracle_db.py

# 查询
python3 $SCRIPT query --all
python3 $SCRIPT query --name orcldg

# 添加
python3 $SCRIPT add \
  --name orcldg \
  --ip 192.168.51.120 \
  --sid orcldg \
  --db-query-user testuser \
  --db-query-user-password Testuser \
  --sysdba-user sys \
  --sysdba-user-password oracle \
  --os-user oracle \
  --os-password 'jxdl@4819!' \
  --adg-peer orclm \
  --desc 主库

# 更新
python3 $SCRIPT update --name orcldg --ip 192.168.51.121
python3 $SCRIPT update --name orcldg --adg-peer orclm-2

# 删除
python3 $SCRIPT delete --name orcldg

# 导出
python3 $SCRIPT export --output ~/oracle_assets.md
```

## Python 模块调用

```python
import sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/oracle-db/scripts"))
from oracle_db import get, dsn, peer

# 查询用户连接（默认）
conn = get("orcldg")
# {"ip", "sid", "user": "testuser", "password": "Testuser", "adg_peer": "orclm", ...}

# SYSDBA 连接
sys = get("orcldg", "sysdba")
# {"user": "sys", "password": "oracle", ...}

# OS 连接（SSH）
os = get("orcldg", "os")
# {"user": "oracle", "password": "jxdl@4819!", "ssh_port": 22, ...}

# DSN
dsn_str = dsn("orcldg")

# ADG 对端名
peer_name = peer("orcldg")  # "orclm"
```

## JSON 结构

```json
{
  "instances": [
    {
      "name": "orcldg",
      "ip": "192.168.51.120",
      "port": 1521,
      "sid": "orcldg",
      "db_query_user": "testuser",
      "db_query_user_password": "enc:...",
      "sysdba_user": "sys",
      "sysdba_user_password": "enc:...",
      "os_user": "oracle",
      "os_password": "enc:...",
      "os_ssh_port": 22,
      "adg_peer": "orclm"
    }
  ]
}
```

## 字段说明

| 字段                   | CLI 参数                 | 说明                       |
| ---------------------- | ------------------------ | -------------------------- |
| name                   | --name                   | 唯一标识                   |
| ip                     | --ip                     | 数据库 IP                  |
| port                   | --port                   | 端口，默认 1521            |
| sid                    | --sid                    | Oracle SID                 |
| db_query_user          | --db-query-user          | 查询用户                   |
| db_query_user_password | --db-query-user-password | 查询用户密码               |
| sysdba_user            | --sysdba-user            | SYSDBA 用户，默认 sys      |
| sysdba_user_password   | --sysdba-user-password   | SYSDBA 密码                |
| os_user                | --os-user                | OS 用户（SSH）             |
| os_password            | --os-password            | OS 密码                    |
| adg_peer               | --adg-peer               | ADG 对端实例名             |

## 依赖

```bash
pip install cryptography
```
