# kapow-qa

Agent 3: QA and feedback against TaskGraph acceptance criteria.

## Overview

Receives a `TaskGraph` and `BuildResult`, reads the actual artifact files from the builder's sandbox,
and uses Claude (`claude-sonnet-4-6`) to evaluate each task's acceptance criteria.

Returns a `QAResult` with:
- `passed`: true only if no critical or major issues found
- `issues`: list of issues with severity (critical/major/minor), taskId, description, and optional file
- `delta`: targeted, actionable description of what needs to be fixed (sent to builder on retry)

## API

### `POST /qa`

**Body:**
```json
{
  "runId": "uuid",
  "taskGraph": { ... },
  "buildResult": { ... }
}
```

**Response:** `QAResult` JSON

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
| `PORT` | No (default: 3003) | Port to listen on |

## Notes

- kapow-qa reads files directly from the sandbox path provided in `BuildResult.sandboxPath`
- All services must run on the same machine (or share a filesystem) for file access to work
- File contents are truncated at 3000 chars per file to stay within context limits
