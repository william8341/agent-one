# Oracle Health Check + Auto-Repair

## 概述

Oracle 数据库健康检查与自动修复工具。执行全面检查并在发现问题时自动尝试修复。

## 目录结构

```
oracle-health-check-repair/
├── run.sh                    # 主入口脚本
├── config/
│   └── thresholds.conf        # 阈值配置
├── lib/
│   ├── common.sh              # 公共函数
│   ├── oracle.sh              # Oracle 数据库操作
│   └── formatter.sh           # 输出格式化
├── checks/                    # 检查模块
│   ├── 01_tablespace.sh       # 表空间检查
│   ├── 02_session.sh          # 会话/锁检查
│   ├── 03_undo.sh             # UNDO 检查
│   ├── 04_archive.sh         # 归档日志检查
│   ├── 05_invalid_objects.sh  # 无效对象检查
│   ├── 06_alertlog.sh        # 告警日志检查
│   └── 07_resource_limit.sh  # 资源限制检查
├── fixes/                     # 修复模块
│   ├── fix_tablespace.sh      # 扩展表空间
│   ├── fix_kill_session.sh   # 终止阻塞会话
│   ├── fix_undo_extend.sh    # 扩展 UNDO
│   ├── fix_archive_purge.sh  # 清理归档日志
│   ├── fix_recompile_obj.sh  # 重新编译对象
│   └── fix_process_limit.sh  # 修改进程限制
└── output/                    # 输出报告
```

## 使用方法

### 使用 oracle-db 资产库（推荐）

```bash
cd ~/.claude/skills/oracle-health-check-repair
./run.sh -n orcldg
./run.sh -n orcldg --no-fix
```

### 使用手动参数

```bash
cd ~/.claude/skills/oracle-health-check-repair
./run.sh -H 192.168.1.100 -u system -p password -s orcl
```

### 使用 Keychain

```bash
./run.sh -k "system@192.168.1.100:orcl"
```

### 使用 Keychain

```bash
./run.sh -k "system@192.168.1.100:orcl"
```

### 仅检查不修复

```bash
./run.sh -H 192.168.1.100 -u system -p password -s orcl --no-fix
```

### 参数说明

| 参数          | 简写 | 说明                    | 默认值                         |
| ------------- | ---- | ----------------------- | ------------------------------ |
| --db-name     | -n   | 数据库名称（oracle-db） | -                              |
| --host        | -H   | Oracle 主机地址         | -                              |
| --port        | -P   | Oracle 端口             | 1521                           |
| --user        | -u   | 数据库用户              | -                              |
| --password    | -p   | 数据库密码              | -                              |
| --sid         | -s   | Oracle SID              | -                              |
| --keychain    | -k   | Mac Keychain 项         | -                              |
| --oracle-home | -    | Instant Client 路径     | ~/downloads/instantclient_23_3 |
| --no-fix      | -    | 仅检查不修复            | false                          |

## 检查项目

| ID  | 检查项            | 阈值 | 修复脚本             |
| --- | ----------------- | ---- | -------------------- |
| 01  | 表空间使用率      | >85% | fix_tablespace.sh    |
| 02  | 阻塞会话          | 存在 | fix_kill_session.sh  |
| 03  | UNDO 使用率       | >80% | fix_undo_extend.sh   |
| 04  | 归档日志使用率    | >90% | fix_archive_purge.sh |
| 05  | 无效对象          | >0   | fix_recompile_obj.sh |
| 06  | 告警日志 ORA 错误 | 存在 | -                    |
| 07  | 进程数限制        | >90% | fix_process_limit.sh |

## 输出示例

### JSON 输出

```json
{
  "check_time": "2026-03-25T10:30:00",
  "connection": {
    "host": "192.168.1.100",
    "port": 1521,
    "user": "system",
    "sid": "orcl",
    "version": "19.0.0.0.0",
    "status": "OPEN"
  },
  "overall_status": "WARNING",
  "issues_found": 1,
  "checks": [
    {
      "id": "01",
      "name": "tablespace",
      "status": "WARNING",
      "message": "1 tablespace(s) above 85%",
      "details": [{ "tablespace": "USERS", "used_pct": 92.5 }],
      "need_fix": true,
      "fix_script": "fix_tablespace.sh"
    }
  ],
  "fixes_applied": [
    {
      "script": "fix_tablespace.sh",
      "status": "SUCCESS",
      "message": "Extended USERS from 1024M to 5120M"
    }
  ]
}
```

### Markdown 输出

```markdown
# Oracle Health Check Report

**Time**: 2026-03-25 10:30:00  
**Host**: 192.168.1.100 (orcl)  
**Status**: ⚠️ WARNING

## Summary

- Issues Found: 1
- Fixes Applied: 1

## Check Results

| ID  | Check      | Status | Message                   |
| --- | ---------- | ------ | ------------------------- |
| 01  | tablespace | ⚠️     | 1 tablespace(s) above 85% |

## Fixes Applied

| Script            | Status | Message                            |
| ----------------- | ------ | ---------------------------------- |
| fix_tablespace.sh | ✅     | Extended USERS from 1024M to 5120M |
```

## 退出码

| 退出码 | 状态                       |
| ------ | -------------------------- |
| 0      | OK - 所有检查通过          |
| 1      | WARNING - 发现问题但已修复 |
| 2      | CRITICAL - 发现严重问题    |
| 3      | ERROR - 执行错误           |

## 配置阈值

编辑 `config/thresholds.conf` 修改阈值：

```json
{
  "tablespace_pct": 85,
  "undo_pct": 80,
  "archive_pct": 90,
  "processes_pct": 90,
  "session_pct": 80,
  "long_running_seconds": 3600,
  "invalid_object_count": 1,
  "alertlog_hours": 24,
  "lock_wait_seconds": 300
}
```

## 设计原则

1. **确定性输出**: 每个检查/修复脚本独立，输出固定格式 JSON
2. **无变量传递**: 步骤间通过状态文件传递，不使用 shell 变量
3. **只执行一次**: 线性执行，检查 → 判断 → 修复 → 结束
4. **幂等修复**: 修复脚本可安全重复执行
5. **LLM 友好**: 固定输出路径，JSON 结构确定，便于解析

## 依赖

- bash 4.0+
- sqlplus (Oracle Instant Client)
- jq
- bc

## 注意事项

- 需要 DBA 权限执行部分检查和修复
- 修复操作建议在测试环境验证后使用
- 生产环境建议先使用 `--no-fix` 确认问题
