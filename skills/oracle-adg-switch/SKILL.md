# Oracle ADG Switch Tool

## 概述

Oracle Active Data Guard (ADG) 切换工具，支持 Switchover 操作。

## 目录结构

```
oracle-adg-switch/
├── SKILL.md               # 文档
├── SWITCHOVER_SUMMARY.md  # 切换测试总结
├── check_adg.sh           # 切换前检查
├── execute_switchover.sh  # 执行切换
├── check_sync.sh          # 检查同步状态
├── rollback_switchover.sh # 回滚脚本
├── lib/
│   ├── common.sh          # 公共函数
│   ├── adg.sh             # ADG 操作
│   └── formatter.sh       # 输出格式化
└── output/                # 输出目录
```

## 使用方法

### 1. 切换前检查（必须执行）

```bash
cd ~/.claude/skills/oracle-adg-switch

./check_adg.sh
```

**检查项：**
- 数据库角色与状态
- 数据库版本、补丁一致性
- 实例状态
- 参数检查
- 主库活动会话
- 归档日志状态
- MRP 进程状态
- 主备 Sequence 一致性
- Archive Gap 检查
- Data Guard 错误检查
- Apply Lag / Transport Lag
- Switchover 状态

### 2. 执行切换

```bash
./execute_switchover.sh
```

**执行步骤：**
1. 验证当前角色
2. 切换主库到备库
3. 重启原主库为备库
4. 切换备库到主库
5. 重启新主库
6. 配置原主库为备库
7. 验证切换结果

### 3. 检查同步状态

```bash
./check_sync.sh
```

**检查项：**
- 主库当前 Sequence
- 备库 Applied Sequence
- 备库 Received Sequence
- MRP 进程状态
- Apply Lag
- Transport Lag
- Archive Gap
- Data Guard 错误

### 4. 回滚切换（如果需要）

```bash
./rollback_switchover.sh
```

## 连接方式

使用 sys 用户以 sysdba 方式连接：
```
sys/oracle@ip:port/sid as sysdba
```

## 当前配置

- 主库: 192.168.51.120:1521/orclm
- 备库: 192.168.51.121:1521/orcldg
- OS 用户: oracle
- OS 密码: jxdl@4819!

## 关键 SQL

### 检查角色
```sql
SELECT database_role FROM v$database;
```

### 检查 switchover 状态
```sql
SELECT switchover_status FROM v$database;
```

### 检查 Sequence
```sql
-- 主库
SELECT MAX(sequence#) FROM v$archived_log WHERE status = 'A';

-- 备库
SELECT MAX(sequence#) FROM v$archived_log WHERE applied = 'YES';
```

### 检查 MRP 状态
```sql
SELECT status FROM v$managed_standby WHERE process LIKE 'MRP%';
```

### 检查延迟
```sql
SELECT value FROM v$dataguard_stats WHERE name='apply lag';
SELECT value FROM v$dataguard_stats WHERE name='transport lag';
```

## 切换步骤

### 主库切换到备库
```sql
ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY WITH SESSION SHUTDOWN;
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;
```

### 备库切换到主库
```sql
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;
SHUTDOWN IMMEDIATE;
STARTUP;
```

## 常见问题

### 1. ORA-12514: Service not registered
**原因：** Listener 问题
**解决：** 使用 SSH + / as sysdba 连接

### 2. Switchover Status: NOT ALLOWED
**原因：** 主库有活动会话
**解决：** 使用 WITH SESSION SHUTDOWN 选项

### 3. 切换后原主库无法连接
**原因：** Listener 未注册
**解决：** 使用 SSH 连接，手动配置

### 4. Data Guard 心跳错误
**原因：** 切换过程中的正常现象
**解决：** 切换完成后自动恢复

## 经验教训

1. **使用 sqlplus -S 简化代码** - 静默模式
2. **使用 SSH 处理本地操作** - 备用连接方式
3. **切换后需要手动配置备库** - 启动并配置 MRP
4. **监控同步状态很重要** - 确保 MRP 进程正常
5. **处理警告而不是失败** - 区分警告和错误

## 注意事项

- 切换会导致短暂的数据库不可用
- 建议在业务低峰期执行
- 切换前确保主库没有活动事务
- 切换后需要更新监听器配置（如果需要）
- 备库变为主库后，原主库需要配置为备库
- 生产环境务必先在测试环境验证

## 测试总结

详见 `SWITCHOVER_SUMMARY.md`
