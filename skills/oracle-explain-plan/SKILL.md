# Oracle 执行计划分析 Skill

## 概述

获取 Oracle SQL 执行计划，分析性能问题，提供优化建议。

## 依赖

- SSH 访问 Oracle 服务器
- sshpass (`brew install sshpass`)
- Python 3

## 使用方法

### 命令行

```bash
python3 ~/.opencode/skills/oracle-explain-plan/scripts/oracle_explain_plan.py \
  --name orclm \
  --sql "SELECT * FROM users WHERE username = 'test'"
```

### 参数

| 参数 | 说明 | 必需 |
|------|------|------|
| --name | 数据库名称 | 是 |
| --sql | SQL 语句 | 是 |
| --format | 输出格式: markdown/json/plain | 否，默认 markdown |

### 输出示例

```markdown
## SQL
```sql
SELECT * FROM users WHERE username = 'test'
```

## 执行计划
```
----------------------------------------------------------
| Id  | Operation         | Name    | Rows  | Bytes | Cost  |
----------------------------------------------------------
|   0 | SELECT STATEMENT |         |     1 |    5M | 12345 |
|*  1 |  TABLE ACCESS FULL| USERS   |     1 |    5M | 12345 |
----------------------------------------------------------
```

## 分析提示
- ⚠️ 全表扫描 - 建议添加索引
- ℹ️ 考虑在 username 列上创建索引
```

## 分析提示说明

| 提示 | 含义 | 建议 |
|------|------|------|
| ⚠️ 全表扫描 | 扫描整个表 | 添加 WHERE 条件索引 |
| ✅ 索引范围扫描 | 使用索引 | 高效 |
| ⚠️ 排序操作 | 需要排序 | 考虑增加索引消除排序 |
| ⚠️ 远程操作 | 跨网络 | 考虑本地化 |
| ℹ️ 嵌套循环 | NL join | 小表驱动大表 |
| ℹ️ 哈希连接 | Hash join | 大表连接 |

## 内部实现

1. 使用 `EXPLAIN PLAN SET STATEMENT_ID='OPENCODE' FOR` 生成计划
2. 使用 `DBMS_XPLAN.DISPLAY` 获取计划详情
3. 通过 SSH + sqlplus 执行
4. 过滤干扰信息，格式化输出
5. 自动识别常见性能问题模式
