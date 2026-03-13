# kapow-actions

MCP server and orchestrator for the Kapow multi-agent developer AI system.

## Overview

`kapow-actions` is the entry point for Claude Code. It exposes MCP tools that trigger the full pipeline:

```
execute_plan(plan) → kapow-planner → kapow-builder → kapow-qa → kapow-gate
```

## MCP Tools

### `execute_plan`

Executes a development plan through the full pipeline. Returns a run ID, streaming progress log, and final artifacts or diagnosis.

**Input:** `{ plan: string }`

### `pipeline_status`

Checks the status of a running or completed pipeline.

**Input:** `{ runId: string }`

## Setup

```bash
npm install
npm run dev   # stdio MCP server
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PLANNER_URL` | `http://localhost:3001` | kapow-planner URL |
| `BUILDER_URL` | `http://localhost:3002` | kapow-builder URL |
| `QA_URL` | `http://localhost:3003` | kapow-qa URL |
| `GATE_URL` | `http://localhost:3004` | kapow-gate URL |

## Claude Code MCP Config

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "kapow": {
      "command": "node",
      "args": ["/path/to/kapow-actions/dist/index.js"]
    }
  }
}
```

Or for development:

```json
{
  "mcpServers": {
    "kapow": {
      "command": "npx",
      "args": ["tsx", "/path/to/kapow-actions/src/index.ts"]
    }
  }
}
```
