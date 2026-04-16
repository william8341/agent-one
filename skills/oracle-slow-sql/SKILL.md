# Oracle 慢 SQL 查询 Skill

## 概述

查询 Oracle 数据库中的慢 SQL、长时间运行操作、会话状态等，供 LLM 分析性能问题。

## 依赖

- SSH 访问 Oracle 服务器
- sshpass (`brew install sshpass`)
- Python 3

## 使用方法

### 命令行

```bash
python3 ~/.opencode/skills/oracle-slow-sql/scripts/oracle_slow_sql.py \
  --name orclm \
  --mode slow \
  --seconds 5 \
  --limit 20
```

### 参数

| 参数 | 说明 | 必需 | 默认值 |
|------|------|------|--------|
| --name | 数据库名称 | 是 | - |
| --mode | 查询模式 | 否 | slow |
| --seconds | 慢 SQL 阈值(秒) | 否 | 5 |
| --minutes | 历史查询时间范围(分钟) | 否 | 30 |
| --limit | 返回行数 | 否 | 20 |
| --format | 输出格式: markdown/json/plain | 否 | markdown |

### 查询模式 (--mode)

| 模式 | 说明 |
|------|------|
| slow | 查询当前慢 SQL (V$SQL) |
| session | 查询活动会话 |
| longops | 查询长时间运行的操作 |
| awr | 查询历史 SQL (需要 AWR) |
| wait | 查询当前等待事件 |

### 使用示例

```bash
# 查询慢 SQL (耗时 > 5 秒)
python3 ~/.opencode/skills/oracle-slow-sql/scripts/oracle_slow_sql.py \
  --name orclm --mode slow --seconds 5

# 查询活动会话
python3 ~/.opencode/skills/oracle-slow-sql/scripts/oracle_slow_sql.py \
  --name orclm --mode session

# 查询等待事件
python3 ~/.opencode/skills/oracle-slow-sql/scripts/oracle_slow_sql.py \
  --name orclm --mode wait

# 查询长时间运行操作
python3 ~/.opencode/skills/oracle-slow-sql/scripts/oracle_slow_sql.py \
  --name orclm --mode longops --seconds 60
```

## 输出示例

```markdown
## 慢 SQL 查询 (耗时 > 5 秒)
```
SQL_ID         CHILD_NUMBER EXECUTIONS ELAPSED_SEC   CPU_SEC BUFFER_GETS DISK_READS ROWS_PROCESSED SQL_TEXT
-------------- ------------ ----------- ------------ ---------- ----------- ---------- ------------- --------
abc123def456              0          1        12.34      10.56      500000       3000        10000 SELECT * FROM...
```
```

## 注意事项

1. 需要 SYSDBA 权限才能访问 V$ 视图
2. AWR 查询需要单独的许可
3. 部分查询可能返回空结果（正常情况）
