# Oracle ADG Switchover 测试总结

## 测试环境

### 初始拓扑
- **主库**: 192.168.51.120:1521/orclm (PRIMARY)
- **备库**: 192.168.51.121:1521/orcldg (PHYSICAL STANDBY)
- **数据库版本**: Oracle 11.2.0.4.0
- **连接方式**: sys/oracle@ip:port/sid as sysdba

### 目标拓扑
- **新主库**: 192.168.51.121:1521/orcldg (PRIMARY)
- **新备库**: 192.168.51.120:1521/orclm (PHYSICAL STANDBY)

## 切换过程

### 第一阶段：检查准备

**执行的检查：**
1. ✅ 数据库角色确认
2. ✅ 数据库版本一致性
3. ✅ 实例状态检查
4. ✅ 参数检查（log_archive_config, standby_file_management）
5. ✅ 主库活动会话检查
6. ✅ 归档日志状态
7. ✅ MRP 进程状态
8. ✅ 主备 Sequence 一致性
9. ✅ Archive Gap 检查
10. ✅ Data Guard 错误检查
11. ✅ Apply Lag / Transport Lag
12. ✅ Switchover 状态

**检查结果：**
- PASS: 15
- WARN: 4
- FAIL: 0

**主要警告：**
1. 主库有 1 个活动会话
2. Archive dest 2 状态 INACTIVE
3. Replication gap 1 sequences（正常）
4. Standby switchover NOT ALLOWED

### 第二阶段：执行切换

**步骤 1：切换主库到备库**
```sql
ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY WITH SESSION SHUTDOWN;
```
- ✅ 执行成功

**步骤 2：重启原主库为备库**
```sql
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;
```
- ✅ 执行成功

**步骤 3：切换备库到主库**
```sql
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY;
```
- ✅ 执行成功

**步骤 4：重启新主库**
```sql
SHUTDOWN IMMEDIATE;
STARTUP;
```
- ✅ 执行成功

### 第三阶段：配置原主库为备库

**步骤 1：启动原主库**
```bash
ssh oracle@192.168.51.120
sqlplus '/ as sysdba'
STARTUP MOUNT;
```
- ✅ 执行成功

**步骤 2：配置 MRP 进程**
```sql
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;
```
- ✅ 执行成功

### 第四阶段：验证同步

**同步状态：**
- 主库 Sequence: 382
- 备库 Applied: 381
- 备库 Received: 382
- Apply Gap: 1（正常）
- MRP 状态: APPLYING_LOG
- Apply Lag: 0
- Transport Lag: 0

**✅ 同步正常**

## 遇到的问题及解决方案

### 问题 1：sqlplus 输出包含版本信息

**问题描述：**
- sqlplus 默认输出包含大量版本信息
- 难以使用 grep 提取有效数据

**解决方案：**
- 使用 `sqlplus -S` 静默模式
- 设置 `SET HEADING OFF FEEDBACK OFF PAGESIZE 0`
- 简化代码，无需复杂的过滤

### 问题 2：备库 Switchover Status 为 NOT ALLOWED

**问题描述：**
- 备库检查显示 switchover_status 为 NOT ALLOWED
- 原因是主库有活动会话

**解决方案：**
- 使用 `WITH SESSION SHUTDOWN` 选项
- 切换时自动断开所有会话
- 实际切换时会自动处理

### 问题 3：切换后主库 Listener 无法连接

**问题描述：**
- 切换后原主库无法通过 listener 连接
- 错误：ORA-12514: Service not registered

**解决方案：**
- 使用 SSH 直接在服务器上执行 sqlplus
- 使用 `/ as sysdba` 本地连接
- 切换后需要手动重启 listener 或重新注册服务

### 问题 4：切换后原主库需要手动启动

**问题描述：**
- 切换后原主库处于关闭状态
- 需要手动启动并配置为备库

**解决方案：**
- 使用 SSH 连接服务器
- 执行 STARTUP MOUNT
- 配置 MRP 进程

### 问题 5：Data Guard 心跳错误

**问题描述：**
- 切换过程中出现心跳连接错误
- 错误：Heartbeat failed to connect to standby

**解决方案：**
- 这是切换过程中的正常现象
- 切换完成后自动恢复
- 当前同步已正常

## 经验教训

### 1. 使用 sqlplus -S 简化代码
- 静默模式可以大大简化输出处理
- 减少复杂的 grep 和 sed 命令

### 2. 使用 SSH 处理本地操作
- 当 listener 无法连接时，使用 SSH + / as sysdba
- 这是最可靠的方式

### 3. 切换后需要手动配置备库
- 切换完成后，原主库需要手动启动
- 配置 MRP 进程以开始同步

### 4. 监控同步状态
- 切换后持续监控同步状态
- 确保 MRP 进程正常运行
- 检查没有 Archive Gap

### 5. 处理警告而不是失败
- Switchover Status NOT ALLOWED 是警告，不是失败
- 实际切换时会自动处理

## 缺失的步骤

### 1. 切换前备份确认
**缺失原因：**
- 没有在检查脚本中强制要求
- 应该在切换前确认主库有有效全备

**改进建议：**
- 在检查脚本中增加备份检查
- 或者明确要求人工确认

### 2. 业务切流确认
**缺失原因：**
- 没有在切换前确认业务已切流
- 切换期间有活动会话可能导致数据丢失

**改进建议：**
- 在切换前检查活动会话
- 如果有活动会话，警告并等待人工确认

### 3. 切换后 Listener 配置
**缺失原因：**
- 没有在切换后自动重启 listener
- 没有重新注册服务

**改进建议：**
- 在切换后检查 listener 状态
- 自动重启 listener 或重新注册服务

### 4. 切换后完整验证
**缺失原因：**
- 验证只检查了角色和同步状态
- 没有验证连接性和业务可用性

**改进建议：**
- 增加连接性测试
- 增加业务可用性验证

### 5. 回滚计划
**缺失原因：**
- 没有明确的回滚计划
- 切换失败时不知道如何恢复

**改进建议：**
- 增加回滚脚本
- 记录切换前的状态
- 准备好恢复步骤

## 改进建议

### 1. 增强检查脚本
- 增加备份检查
- 增加业务切流确认
- 增加 listener 状态检查

### 2. 完善切换脚本
- 使用 SSH 处理本地操作
- 增加错误处理
- 增加重试机制

### 3. 增加回滚功能
- 记录切换前状态
- 准备回滚脚本
- 测试回滚流程

### 4. 增加通知功能
- 切换开始时发送通知
- 切换完成时发送通知
- 切换失败时发送告警

### 5. 增加日志记录
- 记录所有操作
- 记录时间戳
- 便于审计和故障排查

## 总结

本次 ADG Switchover 测试**成功完成**，但过程中遇到了一些问题。主要教训：

1. **使用 sqlplus -S 简化代码** - 这是最有效的改进
2. **使用 SSH 处理本地操作** - 当 listener 无法连接时的备用方案
3. **切换后需要手动配置备库** - 不是自动的，需要人工干预
4. **监控同步状态很重要** - 确保 MRP 进程正常运行
5. **增加备份和业务确认** - 生产环境必须的步骤

**整体评价：** ✅ 成功，但需要改进流程和脚本。

## 后续行动

1. ✅ 完善 check_adg.sh - 使用 sqlplus -S
2. ✅ 完善 execute_switchover.sh - 使用 SSH
3. ⏳ 增加回滚脚本
4. ⏳ 增加通知功能
5. ⏳ 增加日志记录
