# CLAUDE.md

## Agent Routing Rules

在本项目中，Claude Code 遇到以下问题类型时，按如下规则优先分配：

- Oracle 问题 -> `oracle-dba-agent`
- Doris 问题 -> `doris-dba-agent`
- OS / 系统问题 -> `os-admin-agent`

## Dispatch Guidance

- 优先根据用户问题关键词与上下文进行匹配：
  - Oracle: `oracle`, `awr`, `ash`, `tablespace`, `lock`, `rac`, `dataguard`
  - Doris: `doris`, `fe`, `be`, `tablet`, `compaction`, `olap`
  - OS: `os`, `linux`, `cpu`, `memory`, `disk`, `network`, `process`
- 若问题跨域（例如 Doris 性能 + 主机资源），允许并行分配多个 agent。
- 若用户已明确指定 agent，以用户指定为准。
