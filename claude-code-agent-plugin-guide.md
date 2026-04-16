# 将自己的 Agent 接入 Claude Code 完整指南

> 本文档分为两部分：  
> **Part 1** — 改造你的 Agent，使其满足 Claude Code 调用要求  
> **Part 2** — 创建 Claude Code Plugin，为用户提供 Slash 命令

---

## Part 1：改造你的 Agent 满足 Claude Code 调用要求

### 1.1 核心原则

Claude Code 通过两种机制调用外部 Agent：

1. **Bash 工具**：直接执行你的 CLI 命令，捕获 stdout 输出
2. **Subagent 委派**：Claude 将任务委托给声明了 `Bash` 权限的 subagent，由它来调用你的程序

这意味着你的 Agent **不需要**实现任何特殊 API 或协议——只需要成为一个行为良好的 CLI 程序。

---

### 1.2 Agent CLI 接口要求

#### 1.2.1 必须满足的最低要求

**① 可在命令行直接调用**

```bash
# 必须能这样调用你的 agent
your-agent run "帮我分析这段代码的性能问题"

# Claude 会在项目目录下执行，所以需要支持 --cwd 或自动感知当前目录
your-agent run "task description" --cwd /path/to/project
```

**② stdout 输出可被解析**

Claude 读取你程序的 `stdout`，然后将内容转述给用户。输出必须：

- 是纯文本或 Markdown（推荐）
- 不含 ANSI 色彩转义码（`\033[31m` 等）
- 不含交互式 TUI 控件、进度条动画
- 不含需要用户输入的交互提示

```bash
# ✅ 好的输出：纯 Markdown
## 分析结果

发现 3 个性能问题：

1. **N+1 查询**：`user.posts` 应使用 `includes(:posts)`
2. **缺少索引**：`orders.user_id` 字段未建索引
3. **内存泄漏**：`EventEmitter` 未及时移除监听器

# ❌ 不好的输出：带控制字符
\033[32m✓\033[0m 分析完成 [████████░░] 80%
```

**③ 正确使用 exit code**

```bash
# 成功退出
exit 0

# 失败退出（Claude 会知道命令执行失败）
exit 1
```

**④ 错误信息输出到 stderr**

```bash
# 正常结果 → stdout
echo "分析完成，发现 3 个问题"

# 错误信息 → stderr（不会污染 Claude 读取的结果）
echo "错误：无法连接到服务" >&2
```

---

#### 1.2.2 推荐实现的功能

**① `--format` 参数：控制输出格式**

```bash
your-agent run "task" --format markdown   # 默认，适合 Claude 读取
your-agent run "task" --format json       # 结构化数据
your-agent run "task" --format plain      # 纯文本
```

**② `--timeout` 参数：防止长时间阻塞**

Claude Code 的 Bash 工具有超时限制，你的 Agent 应支持：

```bash
your-agent run "task" --timeout 120   # 最多运行 120 秒
```

**③ `version` 子命令：便于 setup 验证**

```bash
your-agent version
# 输出：YourAgent v1.2.3
```

**④ `--output-file` 参数：长结果写入文件**

当结果很长时，写入文件比 stdout 更可靠：

```bash
your-agent run "task" --output-file /tmp/result.md
# stdout 只输出: Result written to /tmp/result.md
```

---

#### 1.2.3 如果需要支持后台运行

仿照 Codex 的 `--background` 模式，让 Claude 可以启动后台任务：

```bash
# 启动后台任务，立即返回 job ID
your-agent run "long task" --background
# stdout 输出：
# job-id: abc-123
# Started background job. Use 'your-agent status abc-123' to check progress.

# 查询状态
your-agent status abc-123
# 输出：
# Status: running (45% complete)
# Started: 2026-04-13 10:30:00
# Estimated completion: 2 minutes

# 获取结果（任务完成后）
your-agent result abc-123

# 取消任务
your-agent cancel abc-123
```

**Job 状态文件示例**（存储在 `~/.your-agent/jobs/` 或项目 `.your-agent/` 目录）：

```json
{
  "job_id": "abc-123",
  "status": "running",
  "progress": 45,
  "started_at": "2026-04-13T10:30:00Z",
  "task": "long task description",
  "pid": 12345,
  "output_file": "/tmp/your-agent-abc-123.md"
}
```

---

### 1.3 认证与配置

#### 1.3.1 支持多种认证方式

Claude Code 的 Bash 工具继承了当前 shell 的环境变量，所以：

```bash
# 方式一：环境变量（推荐，Claude 的 shell 环境可自动继承）
export YOUR_AGENT_API_KEY="sk-xxx"
your-agent run "task"

# 方式二：配置文件（~/.your-agent/config.toml）
your-agent run "task"   # 自动读取配置文件

# 方式三：命令行参数（不推荐，API key 会出现在进程列表）
your-agent run "task" --api-key "sk-xxx"
```

**配置文件示例** (`~/.your-agent/config.toml`)：

```toml
api_key = "sk-xxx"
model = "your-model-v2"
default_timeout = 120
output_format = "markdown"
```

#### 1.3.2 提供 `login` 子命令

```bash
your-agent login
# 交互式登录，将凭证保存到 ~/.your-agent/config.toml

your-agent login --api-key "sk-xxx"
# 非交互式，适合脚本调用
```

---

### 1.4 完整的 Agent CLI 实现示例

以下是一个 Python 实现示例，满足所有 Claude Code 调用要求：

```python
#!/usr/bin/env python3
# your_agent/cli.py

import argparse
import sys
import json
import os
import subprocess
import uuid
from pathlib import Path
from datetime import datetime


def main():
    parser = argparse.ArgumentParser(prog="your-agent")
    subparsers = parser.add_subparsers(dest="command")

    # run 子命令
    run_parser = subparsers.add_parser("run", help="Run agent on a task")
    run_parser.add_argument("task", help="Task description")
    run_parser.add_argument("--cwd", default=os.getcwd(), help="Working directory")
    run_parser.add_argument("--format", choices=["markdown", "json", "plain"],
                            default="markdown", help="Output format")
    run_parser.add_argument("--timeout", type=int, default=120, help="Timeout in seconds")
    run_parser.add_argument("--background", action="store_true", help="Run in background")
    run_parser.add_argument("--output-file", help="Write output to file instead of stdout")

    # status 子命令
    status_parser = subparsers.add_parser("status", help="Check job status")
    status_parser.add_argument("job_id", nargs="?", help="Job ID (optional, shows latest)")

    # result 子命令
    result_parser = subparsers.add_parser("result", help="Get job result")
    result_parser.add_argument("job_id", nargs="?", help="Job ID")

    # cancel 子命令
    cancel_parser = subparsers.add_parser("cancel", help="Cancel a job")
    cancel_parser.add_argument("job_id", help="Job ID")

    # version 子命令
    subparsers.add_parser("version", help="Show version")

    # login 子命令
    login_parser = subparsers.add_parser("login", help="Authenticate")
    login_parser.add_argument("--api-key", help="API key (non-interactive)")

    # setup 子命令（供 Claude Code plugin 的 setup skill 调用）
    subparsers.add_parser("setup-check", help="Verify environment for Claude Code")

    args = parser.parse_args()

    if args.command == "version":
        print("YourAgent v1.0.0")
        return

    if args.command == "setup-check":
        cmd_setup_check()
        return

    if args.command == "login":
        cmd_login(args)
        return

    if args.command == "run":
        cmd_run(args)
        return

    if args.command == "status":
        cmd_status(args)
        return

    if args.command == "result":
        cmd_result(args)
        return

    if args.command == "cancel":
        cmd_cancel(args)
        return

    parser.print_help()


def cmd_setup_check():
    """验证环境，供 Claude Code plugin 的 setup 命令调用"""
    issues = []

    # 检查 API key
    api_key = os.environ.get("YOUR_AGENT_API_KEY") or load_config().get("api_key")
    if not api_key:
        issues.append("✗ API key not found. Set YOUR_AGENT_API_KEY or run: your-agent login")
    else:
        print(f"✓ API key configured ({api_key[:8]}...)")

    # 检查网络连接（可选）
    try:
        import urllib.request
        urllib.request.urlopen("https://api.your-agent.com/health", timeout=5)
        print("✓ API endpoint reachable")
    except Exception:
        issues.append("✗ Cannot reach API endpoint. Check network connection.")

    if issues:
        for issue in issues:
            print(issue, file=sys.stderr)
        sys.exit(1)
    else:
        print("✓ YourAgent is ready to use with Claude Code")


def cmd_run(args):
    """执行任务的核心逻辑"""
    if args.background:
        job_id = start_background_job(args)
        print(f"job-id: {job_id}")
        print(f"Started background job. Use 'your-agent status {job_id}' to check progress.")
        return

    # 前台执行
    try:
        result = execute_task(args.task, cwd=args.cwd, timeout=args.timeout)

        if args.output_file:
            Path(args.output_file).write_text(result)
            print(f"Result written to {args.output_file}")
        elif args.format == "json":
            print(json.dumps({"status": "success", "result": result}))
        else:
            # markdown 或 plain：直接输出给 Claude 读取
            print(result)

    except TimeoutError:
        print(f"Error: Task exceeded {args.timeout}s timeout", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def execute_task(task: str, cwd: str, timeout: int) -> str:
    """实际调用你的 agent 核心逻辑"""
    # 替换为你的实际实现
    # 这里只是示例
    return f"## 任务完成\n\n已处理：{task}\n\n工作目录：{cwd}"


def start_background_job(args) -> str:
    job_id = str(uuid.uuid4())[:8]
    jobs_dir = Path.home() / ".your-agent" / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)

    job_file = jobs_dir / f"{job_id}.json"
    output_file = f"/tmp/your-agent-{job_id}.md"

    job_data = {
        "job_id": job_id,
        "status": "running",
        "started_at": datetime.utcnow().isoformat() + "Z",
        "task": args.task,
        "output_file": output_file
    }
    job_file.write_text(json.dumps(job_data, indent=2))

    # 后台启动（detach）
    cmd = [sys.executable, "-m", "your_agent.worker", job_id, args.task,
           "--cwd", args.cwd, "--output", output_file]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return job_id


def cmd_status(args):
    jobs_dir = Path.home() / ".your-agent" / "jobs"
    if args.job_id:
        job_file = jobs_dir / f"{args.job_id}.json"
    else:
        # 显示最新的 job
        files = sorted(jobs_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not files:
            print("No jobs found.")
            return
        job_file = files[0]

    if not job_file.exists():
        print(f"Job not found: {args.job_id}", file=sys.stderr)
        sys.exit(1)

    job = json.loads(job_file.read_text())
    print(f"Job ID:  {job['job_id']}")
    print(f"Status:  {job['status']}")
    print(f"Started: {job['started_at']}")
    print(f"Task:    {job['task']}")


def cmd_result(args):
    jobs_dir = Path.home() / ".your-agent" / "jobs"
    if args.job_id:
        job_file = jobs_dir / f"{args.job_id}.json"
    else:
        files = sorted(jobs_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not files:
            print("No jobs found.")
            return
        job_file = files[0]

    job = json.loads(job_file.read_text())
    if job["status"] != "completed":
        print(f"Job {job['job_id']} is not yet complete (status: {job['status']})")
        sys.exit(1)

    output_file = Path(job["output_file"])
    if output_file.exists():
        print(output_file.read_text())
    else:
        print("Result file not found.", file=sys.stderr)
        sys.exit(1)


def cmd_cancel(args):
    jobs_dir = Path.home() / ".your-agent" / "jobs"
    job_file = jobs_dir / f"{args.job_id}.json"
    if not job_file.exists():
        print(f"Job not found: {args.job_id}", file=sys.stderr)
        sys.exit(1)

    job = json.loads(job_file.read_text())
    pid = job.get("pid")
    if pid:
        try:
            os.kill(pid, 15)  # SIGTERM
            print(f"Cancelled job {args.job_id}")
        except ProcessLookupError:
            print(f"Job {args.job_id} already finished.")
    job["status"] = "cancelled"
    job_file.write_text(json.dumps(job, indent=2))


def load_config() -> dict:
    config_file = Path.home() / ".your-agent" / "config.toml"
    if not config_file.exists():
        return {}
    try:
        import tomllib
        return tomllib.loads(config_file.read_text())
    except Exception:
        return {}


def cmd_login(args):
    if args.api_key:
        config_dir = Path.home() / ".your-agent"
        config_dir.mkdir(exist_ok=True)
        (config_dir / "config.toml").write_text(f'api_key = "{args.api_key}"\n')
        print("✓ API key saved to ~/.your-agent/config.toml")
    else:
        api_key = input("Enter your API key: ").strip()
        config_dir = Path.home() / ".your-agent"
        config_dir.mkdir(exist_ok=True)
        (config_dir / "config.toml").write_text(f'api_key = "{api_key}"\n')
        print("✓ Logged in successfully")


if __name__ == "__main__":
    main()
```

---

### 1.5 改造检查清单

在将 Agent 接入 Claude Code 之前，逐项确认：

```
CLI 接口
  ☐ 可通过 PATH 中的命令名直接调用
  ☐ 支持 run <task> 子命令
  ☐ 支持 --cwd 参数（或自动使用当前目录）
  ☐ 支持 version 子命令
  ☐ 支持 setup-check 子命令（供 plugin setup 验证）

输出规范
  ☐ 正常结果输出到 stdout
  ☐ 错误信息输出到 stderr
  ☐ 不含 ANSI 转义码
  ☐ 不含交互式提示
  ☐ 输出为 Markdown 或纯文本
  ☐ exit 0 表示成功，exit 非 0 表示失败

认证
  ☐ 支持环境变量读取 API key
  ☐ 支持配置文件（~/.your-agent/config.toml）
  ☐ 提供 login 子命令

可选（后台运行）
  ☐ 支持 --background 参数
  ☐ 支持 status <job-id> 子命令
  ☐ 支持 result <job-id> 子命令
  ☐ 支持 cancel <job-id> 子命令
```

---

---

## Part 2：创建 Claude Code Plugin 提供 Slash 命令

### 2.1 Plugin 完整目录结构

```
your-agent-plugin/
│
├── .claude-plugin/
│   └── marketplace.json              # 仓库级入口（供 /plugin marketplace add 使用）
│
└── plugins/
    └── your-agent/
        ├── .claude-plugin/
        │   └── plugin.json           # 插件元数据
        │
        ├── agents/
        │   └── your-agent.md         # Subagent 定义（Claude 自动委派的核心）
        │
        ├── skills/
        │   ├── run/
        │   │   └── SKILL.md          # /your-agent:run 的行为定义
        │   ├── setup/
        │   │   └── SKILL.md          # /your-agent:setup 的行为定义
        │   ├── status/
        │   │   └── SKILL.md          # /your-agent:status
        │   ├── result/
        │   │   └── SKILL.md          # /your-agent:result
        │   └── review/
        │       └── SKILL.md          # /your-agent:review（示例业务命令）
        │
        └── hooks/
            └── hooks.json            # 生命周期钩子（可选）
```

---

### 2.2 marketplace.json

```json
{
  "bundle": "your-agent",
  "owner": "YourName",
  "description": "YourAgent integration for Claude Code",
  "homepage": "https://github.com/yourname/your-agent-plugin",
  "plugins": [
    {
      "name": "your-agent",
      "description": "Delegate tasks to YourAgent directly from Claude Code",
      "source": "./plugins/your-agent",
      "version": "1.0.0"
    }
  ]
}
```

用户通过以下命令添加你的 marketplace：

```bash
/plugin marketplace add yourname/your-agent-plugin
/plugin install your-agent@your-agent
/reload-plugins
```

---

### 2.3 plugin.json

```json
{
  "name": "your-agent",
  "version": "1.0.0",
  "description": "Use YourAgent from Claude Code for code review, task delegation, and analysis",
  "author": "YourName",
  "homepage": "https://github.com/yourname/your-agent-plugin"
}
```

> **注意**：commands 注册在 skills 目录下，不在 plugin.json 里声明。Claude Code 自动扫描 `skills/` 目录并将每个子目录的名字注册为 `/<plugin-name>:<skill-name>` 命令。

---

### 2.4 Subagent 定义

这是整个 Plugin 最关键的文件，决定 Claude **何时自动委派任务**给你的 Agent：

**`agents/your-agent.md`**

```markdown
---
name: your-agent
description: >
  YourAgent specialist for [your domain]. Use this agent when:
  - The user explicitly asks to use YourAgent
  - The task involves [specific capability 1]
  - The task involves [specific capability 2]
  - Running in background to avoid blocking the main conversation
  Use PROACTIVELY when the task matches YourAgent's strengths.
tools: Bash, Read
model: sonnet
permissionMode: default
---

你是 YourAgent 的操作专员，负责通过 Bash 工具调用 `your-agent` CLI 完成用户任务。

## 调用规范

### 基础调用
```bash
your-agent run "<task description>" --cwd "$PWD" --format markdown
```

### 后台运行（长任务）
```bash
your-agent run "<task>" --background
```

### 查询状态
```bash
your-agent status [job-id]
```

### 获取结果
```bash
your-agent result [job-id]
```

## 行为准则

1. 调用前先确认 `your-agent` 已安装（运行 `which your-agent`）
2. 将 stdout 输出原样返回给用户，不要二次总结
3. 如果 exit code 非 0，将 stderr 内容报告给用户
4. 长任务（预计超过 30 秒）优先使用 `--background`

## 环境检查

如果调用失败，提示用户运行 `/your-agent:setup` 检查环境。
```

---

### 2.5 核心 Skill 文件详解

#### 2.5.1 `/your-agent:setup` — 环境验证命令

**`skills/setup/SKILL.md`**

```markdown
---
name: setup
description: >
  Verify YourAgent is installed and configured for use with Claude Code.
  Run this first after installing the plugin.
---

# YourAgent Setup

检查 YourAgent 的安装状态和认证配置。

## 步骤

1. 使用 Bash 工具运行环境检查：

```bash
your-agent setup-check
```

2. 根据检查结果：

**如果一切正常**（exit code 0）：
向用户确认 YourAgent 已就绪，并列出可用命令：
- `/your-agent:run` — 执行任务
- `/your-agent:review` — 代码审查
- `/your-agent:status` — 查看后台任务状态
- `/your-agent:result` — 获取任务结果

**如果未安装**（命令不存在）：
提示安装方式：
```bash
# Python 包
pip install your-agent

# 或 npm 包
npm install -g @yourname/your-agent
```

**如果未认证**（API key 缺失）：
提示用户：
```bash
your-agent login
# 或设置环境变量：
export YOUR_AGENT_API_KEY="sk-xxx"
```

**如果网络不可达**：
提示检查网络连接或代理设置。

## 注意

- 不要显示完整的 API key，只显示前 8 位加 `...`
- setup 完成后建议用户先用 `/your-agent:run` 做一次简单测试
```

---

#### 2.5.2 `/your-agent:run` — 执行任务命令

**`skills/run/SKILL.md`**

```markdown
---
name: run
description: >
  Run YourAgent on a task. Supports foreground and background execution.
  Usage: /your-agent:run [--background] [--timeout N] <task description>
---

# Run YourAgent

将任务委派给 YourAgent 执行。

## 参数解析

从用户输入中提取：
- `--background` / `-b`：后台运行（长任务推荐）
- `--timeout <秒>`：超时时间（默认 120 秒）
- 其余内容：任务描述

## 执行逻辑

### 前台执行（短任务）

```bash
your-agent run "<task>" --cwd "$PWD" --format markdown
```

将输出原样展示给用户。

### 后台执行（`--background` 或任务明显耗时较长时）

```bash
your-agent run "<task>" --cwd "$PWD" --background
```

输出示例：
```
job-id: abc-123
Started background job. Use 'your-agent status abc-123' to check progress.
```

收到 job-id 后，告知用户：
- 使用 `/your-agent:status` 查看进度
- 使用 `/your-agent:result` 获取完成后的结果
- 使用 `/your-agent:cancel <job-id>` 取消任务

## 错误处理

- exit code 非 0 → 展示 stderr 内容，建议运行 `/your-agent:setup`
- 命令不存在 → 提示用户安装并运行 `/your-agent:setup`
- 超时 → 建议使用 `--background` 重试

## 示例调用

```
用户输入：/your-agent:run 分析 src/ 目录下的安全漏洞
→ 执行：your-agent run "分析 src/ 目录下的安全漏洞" --cwd "$PWD" --format markdown

用户输入：/your-agent:run --background 重构整个 API 层
→ 执行：your-agent run "重构整个 API 层" --cwd "$PWD" --background
```
```

---

#### 2.5.3 `/your-agent:review` — 代码审查命令（业务专用示例）

**`skills/review/SKILL.md`**

```markdown
---
name: review
description: >
  Run YourAgent code review on current changes or a specific branch.
  Usage: /your-agent:review [--base <branch>] [--background] [focus text]
---

# YourAgent Code Review

对当前代码变更运行 YourAgent 审查。

## 参数解析

从用户输入中提取：
- `--base <branch>`：与指定分支对比（如 `--base main`），默认审查工作区变更
- `--background`：后台运行
- 剩余文本：审查重点描述（可选）

## 执行步骤

### Step 1：收集 Git 上下文

```bash
# 获取变更的文件列表
git diff --name-only HEAD

# 如果指定了 --base
git diff --name-only <base>...HEAD
```

### Step 2：构建任务描述

将 git diff 信息和用户的审查重点合并成任务：

```
请对以下变更进行代码审查：

变更文件：
- src/auth.py（+45, -12 行）
- src/models/user.py（+8, -3 行）

用户关注点：[用户输入的 focus text，如果有的话]

请检查：安全漏洞、性能问题、代码质量、测试覆盖
```

### Step 3：调用 YourAgent

```bash
your-agent run "<构建的任务描述>" --cwd "$PWD" --format markdown
```

或后台：

```bash
your-agent run "<任务描述>" --cwd "$PWD" --background
```

## 输出格式期望

引导 YourAgent 按以下格式输出（可在任务描述中指定）：

```markdown
## 代码审查报告

### 🔴 严重问题（必须修复）
...

### 🟡 警告（建议修复）
...

### 💡 建议（可选优化）
...

### ✅ 总体评估
...
```

## 示例

```
/your-agent:review
→ 审查当前工作区所有变更

/your-agent:review --base main
→ 审查当前分支相对于 main 的所有变更

/your-agent:review --background 重点关注认证逻辑的安全性
→ 后台审查，聚焦认证模块
```
```

---

#### 2.5.4 `/your-agent:status` — 任务状态命令

**`skills/status/SKILL.md`**

```markdown
---
name: status
description: >
  Check the status of background YourAgent jobs.
  Usage: /your-agent:status [job-id]
---

# YourAgent Job Status

查看后台任务的运行状态。

## 执行

```bash
# 查看指定任务
your-agent status <job-id>

# 查看最新任务（无参数时）
your-agent status
```

## 输出解读

| 状态 | 含义 | 建议操作 |
|------|------|---------|
| `running` | 正在运行 | 等待，或稍后再查 |
| `completed` | 已完成 | 运行 `/your-agent:result` 获取结果 |
| `failed` | 失败 | 查看错误信息，考虑重试 |
| `cancelled` | 已取消 | — |

## 如果没有运行中的任务

提示用户使用 `/your-agent:run --background <task>` 启动后台任务。
```

---

#### 2.5.5 `/your-agent:result` — 获取任务结果命令

**`skills/result/SKILL.md`**

```markdown
---
name: result
description: >
  Retrieve the result of a completed background YourAgent job.
  Usage: /your-agent:result [job-id]
---

# YourAgent Job Result

获取已完成的后台任务结果。

## 执行

```bash
your-agent result [job-id]
```

不提供 job-id 时，返回最近一次完成任务的结果。

## 状态处理

- **已完成**：将结果原样展示给用户
- **未完成**：提示任务还在运行，建议先用 `/your-agent:status` 确认
- **任务不存在**：提示检查 job-id 是否正确
```

---

### 2.6 生命周期 Hooks（可选）

**`hooks/hooks.json`**

```json
{
  "hooks": [
    {
      "event": "SessionStart",
      "script": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
      "timeout": 5000,
      "description": "Check YourAgent availability on session start"
    },
    {
      "event": "SessionEnd",
      "script": "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.sh",
      "timeout": 5000,
      "description": "Clean up temporary files"
    }
  ]
}
```

**`hooks/session-start.sh`**

```bash
#!/bin/bash
# 会话开始时静默检查 agent 可用性
# 不输出任何内容（避免打扰用户）
# 只记录日志

if ! command -v your-agent &>/dev/null; then
    # 写入日志，不打断用户
    echo "[$(date)] YourAgent not found" >> ~/.your-agent/claude-code.log
fi
```

**`hooks/session-end.sh`**

```bash
#!/bin/bash
# 清理会话临时文件
rm -f /tmp/your-agent-session-*.md 2>/dev/null
```

---

### 2.7 完整用户交互流程示例

安装并使用整个 Plugin 的完整流程：

```bash
# === 安装 ===
# 1. 添加 marketplace
/plugin marketplace add yourname/your-agent-plugin

# 2. 安装插件
/plugin install your-agent@your-agent

# 3. 重载
/reload-plugins

# === 初始设置 ===
# 4. 验证环境
/your-agent:setup
# → ✓ YourAgent v1.0.0 installed
# → ✓ API key configured (sk-abc123...)
# → ✓ API endpoint reachable
# → YourAgent is ready to use!

# === 日常使用 ===

# 前台任务（立等可取）
/your-agent:run 解释 src/auth.py 中的权限检查逻辑

# 后台任务（不阻塞对话）
/your-agent:run --background 对整个项目做依赖安全扫描

# 代码审查
/your-agent:review --base main

# 查看后台任务进度
/your-agent:status

# 获取完成的结果
/your-agent:result

# === Claude 自动委派（无需 slash 命令）===
用户："帮我用 YourAgent 检查一下这段 SQL 有没有注入风险"
→ Claude 自动识别，委派给 your-agent subagent 处理
```

---

### 2.8 Skill 文件编写最佳实践

#### 2.8.1 description 字段：触发精度决定用户体验

```markdown
# ❌ 太模糊，Claude 不知道何时调用
description: Run YourAgent

# ✅ 明确场景 + 触发词 + 参数格式
description: >
  Run YourAgent on a specific task. Use when user explicitly invokes /your-agent:run,
  or asks to delegate work to YourAgent.
  Usage: /your-agent:run [--background] [--timeout N] <task description>
```

#### 2.8.2 在 Skill 中明确错误处理路径

每个 skill 都应定义：
- 命令成功 → 如何展示结果
- exit code 非 0 → 展示什么错误提示
- 命令不存在 → 引导到 setup

#### 2.8.3 避免在 Skill 里硬编码路径

```markdown
# ❌ 硬编码
your-agent run "task" --cwd /Users/alice/project

# ✅ 使用 Claude 的上下文变量
your-agent run "task" --cwd "$PWD"
```

#### 2.8.4 保持 Skill 专注单一职责

每个 skill 只做一件事。复杂的业务逻辑（如"先 review 再修复"）通过组合多个 skill 或在 subagent 的系统提示词中编排。

---

### 2.9 发布与维护

#### 发布到 GitHub 供他人使用

```bash
# 仓库结构
yourname/your-agent-plugin/
├── .claude-plugin/marketplace.json
└── plugins/your-agent/...

# 用户安装
/plugin marketplace add yourname/your-agent-plugin
/plugin install your-agent@your-agent
```

#### 版本管理

在 `plugin.json` 中更新版本号，用户通过以下命令更新：

```bash
/plugin update your-agent@your-agent
```

#### 本地开发调试

```bash
# 直接用本地路径加载插件（无需发布）
claude --plugin-dir ./plugins/your-agent

# 或在 Claude Code 中
/plugin install file:///absolute/path/to/plugins/your-agent
/reload-plugins
```

---

## 附录：两部分的关联关系

```
你的 Agent CLI (Part 1)
        ↑
        │  Bash 调用
        │
Plugin Skill (Part 2) ←── 用户输入 /your-agent:run
        │
        │  内部委派
        ↓
Plugin Subagent (Part 2) ←── Claude 自动识别任务并委派
        │
        │  Bash 调用
        ↓
你的 Agent CLI (Part 1)
```

**核心逻辑**：Skill 和 Subagent 都是"桥梁"——它们告诉 Claude 什么时候该调用你的 Agent、怎么调用，以及如何处理结果。你的 Agent CLI 只需要关注自己的业务逻辑，通过规范的 stdin/stdout/exit code 与 Claude Code 的世界对接。
