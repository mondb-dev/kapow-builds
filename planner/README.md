# kapow-planner

Agent 1: Plan validation, research, and task graph creation.

## Overview

Receives a raw development plan string and uses Claude (`claude-sonnet-4-6`) to:
- Validate feasibility
- Resolve ambiguities
- Decompose into atomic tasks with types, dependencies, and acceptance criteria
- Return a structured `TaskGraph` JSON

## API

### `POST /plan`

**Body:**
```json
{
  "runId": "uuid",
  "plan": "Build a REST API for a todo app with TypeScript and Express"
}
```

**Response:** `TaskGraph` JSON

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
| `PORT` | No (default: 3001) | Port to listen on |
