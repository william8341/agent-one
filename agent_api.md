# Agent 执行接口文档

## 一、提交 Agent 执行任务

### 请求信息

| 项目 | 值 |
|------|-----|
| **URL** | `/api/external/agent-executions` |
| **Method** | `POST` |
| **Content-Type** | `application/json` |

### Header 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `Authorization` | string | 是 | Token 认证，格式：`Bearer <token>` |

### 请求参数

```json
{
    "workspace_id": "1bf7cfcf-9af8-4715-85e1-ffb7cdfeaf73",
    "agent_name": "agent-one",
    "user_input": "帮我搜索下网络，查看最新的新闻"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workspace_id` | string | 否 | 工作空间 ID |
| `agent_name` | string | 是 | Agent 名称，如 `qwen3.5` |
| `user_input` | string | 是 | 用户输入指令 |

### 返回参数

返回 JSON 格式，包含 `execution_id`：

```json
{
    "execution_id": "2667d05a-73d6-4dcd-8773-9ee66ce29ab5"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `execution_id` | string | 执行任务 ID，用于查询执行结果 |

---

## 二、查询 Agent 执行结果

### 请求信息

| 项目 | 值 |
|------|-----|
| **URL** | `/api/external/agent-executions/query` |
| **Method** | `POST` |
| **Content-Type** | `application/json` |

### Header 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `Authorization` | string | 是 | Token 认证，格式：`Bearer <token>` |

### 请求参数

```json
{
    "execution_id": "2667d05a-73d6-4dcd-8773-9ee66ce29ab5"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `execution_id` | string | 是 | 执行任务 ID（由接口一返回） |

### 返回参数

```json
{
    "success": true,
    "data": {
        "agent_id": "58eaae62-8bd8-4ea3-9762-5040f7ac9e9b",
        "execution_id": "2667d05a-73d6-4dcd-8773-9ee66ce29ab5",
        "output_result": {
            "evidence_items": {
                "E1": {
                    "id": "E1",
                    "record_id": "R1",
                    "step": 1,
                    "step_type": "tool_call",
                    "description": "使用 web search and crawl 工具搜索最新新闻",
                    "profile": "generic",
                    "field": "message",
                    "field_path": "result.message",
                    "success": true,
                    "kind": "error_status",
                    "status": "no urls found to crawl for the query: latest news.",
                    "output_preview": "No URLs found to crawl for the query: latest news.",
                    "score": 7
                },
                "E2": {
                    "id": "E2",
                    "step": 1,
                    "step_type": "tool_call",
                    "command": "latest news",
                    "description": "使用 web search and crawl 工具搜索最新新闻",
                    "output_preview": "No URLs found to crawl for the query: latest news.",
                    "success": true
                }
            },
            "text": "## 执行结果分析\n\n..."
        },
        "output_text": "## 执行结果分析\n\n...",
        "status": "成功",
        "status_code": "success",
        "status_desc": "任务处理完成",
        "workspace_id": "1bf7cfcf-9af8-4715-85e1-ffb7cdfeaf73"
    }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 请求是否成功 |
| `data.agent_id` | string | Agent ID |
| `data.execution_id` | string | 执行任务 ID |
| `data.output_result.evidence_items` | object | 证据项列表 |
| `data.output_result.text` | string | 执行结果文本（Markdown 格式） |
| `data.output_text` | string | 输出文本（Markdown 格式） |
| `data.status` | string | 执行状态，如 "成功" |
| `data.status_code` | string | 状态码，如 "success" |
| `data.status_desc` | string | 状态描述 |
| `data.workspace_id` | string | 工作空间 ID |

---

## 三、使用流程

```
┌─────────────┐      ┌──────────────────┐      ┌────────────────────┐
│  提交任务   │ ───► │  获取 execution_id │ ───► │   查询执行结果     │
│ POST /executions│      │   2667d05a...      │      │ GET /executions/query │
└─────────────┘      └──────────────────┘      └────────────────────┘
```
