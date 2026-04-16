# agent-one

`agent-one` is an enterprise AI agent CLI with TUI and task execution APIs.

## Install and Run TUI

```bash
npm install
npm run build
npm link
agent-one
```

`npm link` installs the local `agent-one` command into your PATH. Running `agent-one` without arguments starts the TUI.

## Local solution memory

Successful fixes can be stored under `~/.agent-one/solutions/` as Markdown (YAML frontmatter). The agent can call tools `memory_search`, `memory_save`, and `memory_delete`. Mark sensitive notes with `mark_private` (hidden from default search) or edit/delete files on disk to remove data.

## Skills directory (`skills/`)

The `skills/` folder is listed in `.gitignore` so local or sensitive skill definitions (scripts, Oracle assets, run outputs) are **not** committed. Add your own `skills/` beside the project; clones get an empty skills tree until you copy them in. To ship example skills publicly, use a separate repo or release artifact.

## Team MVP (Hybrid Mode B)

This repository includes an MVP team runner where:

- Claude generates a structured plan JSON
- `agent-one team execute` deterministically executes external member CLIs
- Results are stored under `.agent-team-runs/<run-id>/`

### Quick start

```bash
# Optional: regenerate templates
agent-one team init

# Generate plan via Claude (strict JSON output)
agent-one team plan --goal "review code changes and run tests"

# Execute generated plan
agent-one team execute --plan team/plan.generated.json

# Execute and print live process logs
agent-one team execute --plan team/plan.generated.json --verbose
```

Default files:

- `team/team.yaml`: external team members and command templates
- `team/plan.schema.json`: plan schema for planner output validation
- `team/example.plan.json`: sample plan

Planner command:

```bash
agent-one team plan --goal "<your goal>" [--model <name>] [--output team/plan.generated.json]
```

If Claude output is not valid JSON, or references unknown team members, the command fails fast.
`team plan` also validates that each step `inputs` key is declared by that agent's command templates in `team/team.yaml` (e.g. `{{inputs.foo}}` declares `foo`).

Execution output:

- `.agent-team-runs/<run-id>/summary.json`
- `.agent-team-runs/<run-id>/final.md`
- `.agent-team-runs/<run-id>/<step-id>.md`
- `.agent-team-runs/<run-id>/<step-id>.result.json`

## Start HTTP Service

Build first:

```bash
npm run build
```

Start the service:

```bash
node dist/index.js serve --host 0.0.0.0 --port 8080 --token your-token
```

You can also set token via environment variable:

```bash
AGENT_ONE_HTTP_TOKEN=your-token node dist/index.js serve --port 8080
```

## curl Example: Submit + Poll

Set shared variables:

```bash
BASE_URL="http://127.0.0.1:8080"
TOKEN="your-token"
```

### 1) Submit an execution task

```bash
submit_resp=$(curl -sS -X POST "$BASE_URL/api/external/agent-executions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "1bf7cfcf-9af8-4715-85e1-ffb7cdfeaf73",
    "agent_name": "agent-one",
    "user_input": "帮我搜索下网络，查看最新的新闻"
  }')

echo "$submit_resp"
execution_id=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.execution_id||"")' "$submit_resp")
echo "execution_id=$execution_id"
```

### 2) Poll query API until finish

```bash
while true; do
  query_resp=$(curl -sS -X POST "$BASE_URL/api/external/agent-executions/query" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"execution_id\":\"$execution_id\"}")

  status_code=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x?.data?.status_code||"")' "$query_resp")
  status_desc=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x?.data?.status_desc||"")' "$query_resp")
  echo "status_code=$status_code status_desc=$status_desc"

  if [ "$status_code" = "success" ] || [ "$status_code" = "failed" ] || [ "$status_code" = "cancelled" ]; then
    echo "$query_resp"
    break
  fi

  sleep 2
done
```

### 3) Extract final Markdown output

```bash
node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write((x?.data?.output_text||"") + "\n")' "$query_resp"
```
