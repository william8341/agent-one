# Oracle AWR Report Generator

Generate Oracle AWR (Automatic Workload Repository) reports for LLM analysis.

## Overview

This skill generates AWR reports from Oracle databases and prepares them for AI/LLM analysis. It supports Oracle 11g, 12c, 19c, and 21c+.

## Usage

```bash
cd ~/.claude/skills/oracle-awr-generator

# Generate report for last hour using oracle-db asset
./run.sh -n orclm

# Generate report for last 2 hours
./run.sh -n orclm -h 2

# Generate HTML report
./run.sh -n orclm -t HTML

# Generate full report (not just TYPICAL)
./run.sh -n orclm -f FULL

# Manual connection
./run.sh -H 192.168.1.100 -u system -p password -s orcl
```

## Parameters

| Parameter | Short | Description | Default |
|-----------|-------|-------------|---------|
| --db-name | -n | Database name in oracle-db inventory | - |
| --host | -H | Oracle host | - |
| --port | -P | Oracle port | 1521 |
| --user | -u | Database user | - |
| --password | -p | Database password | - |
| --sid | -s | Oracle SID | - |
| --keychain | -k | Mac Keychain item (user@host:sid) | - |
| --hours-back | -h | Hours to look back | 1 |
| --type | -t | Report type: TEXT or HTML | TEXT |
| --format | -f | Report format: SHORT or FULL | SHORT |
| --oracle-home | - | Oracle Instant Client path | ~/downloads/instantclient_23_3 |

## Output

- AWR report saved to: `output/awr_<sid>_<timestamp>.text` (or .html)
- Summary printed to stdout
- Full report available for LLM analysis

## Requirements

- Oracle Instant Client
- DBA privileges (for AWR access)
- Oracle Diagnostics Pack license (for AWR features)

## Skill File Structure

```
oracle-awr-generator/
├── run.sh           # Main script
├── SKILL.md         # This file
└── output/          # Generated reports
```
