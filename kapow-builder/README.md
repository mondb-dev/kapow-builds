# kapow-builder

Agent 2: Sandbox creation and implementation using Claude Opus with tools.

## Overview

Receives a `TaskGraph` and implements all tasks inside an isolated sandbox at `/tmp/kapow/{runId}`.
Uses Claude (`claude-opus-4-6`) with a full tool suite:

- `shell_exec` — run any shell command (npm, git, curl, tests)
- `file_write` / `file_read` / `file_list` — manage files in sandbox
- `git_commit` — commit progress
- `browser_navigate` / `browser_screenshot` — headless browser via puppeteer-core

## API

### `POST /build`

**Body:**
```json
{
  "runId": "uuid",
  "taskGraph": { ... }
}
```

**Response:** `BuildResult` JSON

### `POST /fix`

Targeted fix — reuses existing sandbox, applies only the delta.

**Body:**
```json
{
  "runId": "uuid",
  "taskGraph": { ... },
  "previousBuildResult": { ... },
  "delta": "What needs to be fixed...",
  "iteration": 2
}
```

**Response:** `BuildResult` JSON

### `GET /health`

Health check.

## Setup

```bash
npm install
ANTHROPIC_API_KEY=sk-... npm run dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `PORT` | No (default: 3002) | Port to listen on |
| `SANDBOX_BASE` | No (default: /tmp/kapow) | Base directory for sandboxes |
| `CHROME_WS_ENDPOINT` | No | CDP endpoint for existing Chrome instance |
| `CHROME_PATH` | No | Path to Chrome binary for headless launch |
