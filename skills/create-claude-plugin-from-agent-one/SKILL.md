---
name: create-claude-plugin-from-agent-one
description: 基于 agent-one plugin 模板，生成新的 Claude Code plugin（含 marketplace、agents、skills、hooks）。
when-to-use: 当用户要求“新建/批量创建 Claude Code plugin”，并希望沿用 agent-one 的结构与行为规范时使用。
allowed-tools:
  - ReadFile
  - Glob
  - Grep
  - Write
  - Edit
  - MultiEdit
  - Bash
---

# Create Claude Code Plugin from agent-one Template

## 概述

以 `agent-one` 插件为模板，自动生成新插件目录与配置，保持 Claude Code 插件格式一致（marketplace + plugin manifest + agents + skills + hooks）。

## 输入参数（必填）

- `plugin_name`: 插件名（例如 `doris-dba-agent`）
- `binary_command`: 实际 CLI 命令（例如 `doris-dba-agent`）
- `display_name`: 展示名称（例如 `Doris DBA Agent`）
- `template_repo`: 模板仓库根目录（例如 `/Users/.../agent-one-claude-code-plugin`）

## 输入参数（可选）

- `extra_skills`: 专属 skill 列表（例如 `["doris-dba"]`）
- `homepage`: 插件主页 URL（默认沿用模板）
- `version`: 版本号（默认 `1.0.0`）

## 目标结构

在 `<template_repo>/plugins/<plugin_name>/` 生成：

- `.claude-plugin/plugin.json`
- `agents/<plugin_name>.md`
- `skills/run/SKILL.md`
- `skills/setup/SKILL.md`
- `skills/review/SKILL.md`
- `skills/status/SKILL.md`
- `skills/result/SKILL.md`
- `hooks/hooks.json`
- `hooks/session-start.sh`
- `hooks/session-end.sh`
- `skills/<extra_skill>/SKILL.md`（如配置）

## 生成步骤

1. 读取模板文件（来源固定为 `plugins/agent-one`）：
   - `agents/agent-one.md`
   - `skills/{run,setup,review,status,result}/SKILL.md`
   - `hooks/hooks.json`
   - `hooks/session-start.sh`
   - `hooks/session-end.sh`
2. 创建目标目录并写入文件。
3. 对模板内容执行替换：
   - `agent-one` -> `<plugin_name>`（命令与 slash 前缀）
   - `AgentOne` -> `<display_name>`（文案展示）
   - `/agent-one:` -> `/<plugin_name>:`
   - `[agent-one-cli]` -> `[<binary_command>-cli]`
   - `agent_one_cli` -> `<plugin_name 下划线形式>_cli`
4. 修改 `hooks/session-start.sh`：
   - `command -v agent-one` -> `command -v <binary_command>`
   - `~/.agent-one` -> `~/.<plugin_name>`
5. 修改 `hooks/session-end.sh`：
   - `/tmp/agent-one-session-*` -> `/tmp/<plugin_name>-session-*`
6. 更新 `/.claude-plugin/marketplace.json` 的 `plugins[]`：
   - 新增 `{name, source, description, version, author, homepage}`
7. 执行校验：
   - `npm run build`（应通过 marketplace / plugin manifests 校验）

## 强约束

- 不要改动已有插件条目顺序（仅追加新条目）。
- 不要删除模板中的关键规则段落（如 “CRITICAL — real Bash only”）。
- 生成后的 `run` skill 必须要求：
  - 展示真实执行命令
  - 返回真实 stdout/stderr
  - 禁止伪造输出
- 若目标插件已存在，先提示并要求确认“覆盖”或“跳过”。

## 完成标准（DoD）

- `marketplace.json` 包含新插件条目且 JSON 合法
- 新插件 `plugin.json` 与 5 个核心 `skills` 文件齐全
- `agents/<plugin_name>.md` 可被 Claude Code 自动委派使用
- `hooks` 三个文件存在且命令名已替换
- `npm run build` 返回成功

## 示例

### 示例输入

- `plugin_name`: `os-admin-agent`
- `binary_command`: `os-admin-agent`
- `display_name`: `OS Admin Agent`
- `template_repo`: `/Users/me/agent-one-claude-code-plugin`
- `extra_skills`: `["os-admin"]`

### 示例安装

```bash
/plugin marketplace add /Users/me/agent-one-claude-code-plugin
/plugin install os-admin-agent@agent-one
/reload-plugins
```
