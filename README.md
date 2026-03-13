# kapow-builds

Multi-agent autonomous developer pipeline. Receives a plan, executes it through 4 AI agents, returns quality output.

## Architecture

```
kapow-actions (MCP + HTTP :3000)  — orchestrator
  ├─ kapow-planner (:3001)        — plan → task graph (sonnet)
  ├─ kapow-builder (:3002)        — task graph → implementation (opus)
  ├─ kapow-qa (:3003)             — build → QA report (sonnet)
  └─ kapow-gate (:3004)           — QA → go/no-go/escalate (haiku)
```

## Quick start

```bash
export ANTHROPIC_API_KEY=...

# Start all agents
cd kapow-planner && npm install && npm run dev &
cd kapow-builder && npm install && npm run dev &
cd kapow-qa && npm install && npm run dev &
cd kapow-gate && npm install && npm run dev &
cd kapow-actions && npm install && npm run dev &
```

## Environment variables

| Var | Used by | Required |
|-----|---------|----------|
| `ANTHROPIC_API_KEY` | all agents | yes |
| `GITHUB_TOKEN` | kapow-builder | for repo creation |
| `VERCEL_TOKEN` | kapow-builder | for Vercel deploys |
| `NETLIFY_TOKEN` | kapow-builder | for Netlify deploys |
| `ALLOWED_ORIGINS` | kapow-actions | CORS whitelist (comma-separated) |
