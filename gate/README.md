# kapow-gate

Agent 4: CI gate — pass/fail signal, targeted retry orchestration, escalation diagnosis.

## Overview

Receives a `QAResult` and the current iteration count. Decides:

- `go`: QA passed — emit CI signal, return artifacts
- `no-go`: QA failed but retries remain — return targeted delta for builder
- `escalate`: QA failed after 3 iterations — generate diagnosis with Claude Haiku and return to user

Uses Claude (`claude-haiku-4-5-20251001`) only on escalation to write the failure diagnosis report.
All other logic is deterministic (no LLM call on pass or no-go).

## API

### `POST /gate`

**Body:**
```json
{
  "runId": "uuid",
  "qaResult": { ... },
  "iteration": 1,
  "artifacts": [ ... ]
}
```

**Response:** `GateResult` JSON

```json
{
  "runId": "uuid",
  "ciSignal": "go" | "no-go" | "escalate",
  "iteration": 1,
  "delta": "What needs to be fixed (on no-go)",
  "diagnosis": "Failure analysis (on escalate)",
  "artifacts": [ ... ]
}
```

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
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (used only for escalation diagnosis) |
| `PORT` | No (default: 3004) | Port to listen on |

## Retry Logic

- Max iterations: 3
- On iterations 1 and 2: `no-go` with delta sent back to `kapow-builder /fix`
- On iteration 3: `escalate` with Claude Haiku diagnosis
