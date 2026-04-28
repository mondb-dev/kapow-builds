# Kapow

AI development pipeline that learns. Describe what you want to build, Kapow plans it, builds it, tests it, and ships it — getting better with every project.

## Architecture

```
              ┌──────────────────┐
              │     User Input   │
              └────────┬─────────┘
                ┌──────┴──────┐
          ┌─────▼─────┐ ┌────▼─────┐
          │   Board   │ │   MCP    │
          │   (UI)    │ │ (Claude) │
          │  :3005    │ │ (stdio)  │
          └─────┬─────┘ └────┬─────┘
                └──────┬──────┘
                       │
              ┌────────▼────────┐
              │    Pipeline     │  :3000
              │  (one process)  │
              │                 │
              │  planner()      │  ← direct function call
              │     ↓           │
              │  buildTask()    │  ← direct function call + tools
              │     ↓           │
              │  runTaskQA()    │  ← direct function call (read-only)
              │     ↓           │
              │  evaluate()     │  ← direct function call
              │   ↓     ↓      │
              │  go   no-go    │  ← retry up to 3x
              └───────┬────────┘
                      │
          ┌───────────┼───────────┐
          │                       │
  ┌───────▼───────┐     ┌────────▼────────┐
  │  Technician   │     │   PostgreSQL    │
  │  :3006        │     │   (shared)      │
  │               │     └─────────────────┘
  │  tools        │
  │  recipes      │  ← the learning engine
  │  research     │
  └───────────────┘
```

### Three Services

| Service | Port | Role |
|---------|------|------|
| **pipeline** | 3000 | Consolidated orchestrator — planner, builder, QA, gate run as direct function calls inside one process. No HTTP between agents. MCP server + HTTP API. |
| **technician** | 3006 | The learning engine. Researches, builds, tests, and documents reusable tools. Maintains tool + recipe registry. Gets smarter with every project. |
| **board** | 3005 | Next.js 15 dashboard. Project creation with briefs + file uploads, Kanban board, run logs, agent activity viewer. |

### Why Three, Not Nine

The original architecture had 9 services (planner, builder, QA, gate as separate HTTP servers). That added network latency, failure modes, and ops overhead for zero benefit — each "agent" is a single LLM prompt. Now they're function calls in one process:

- **Zero latency** between agents
- **One process** holds full context
- **Fewer failure modes** (no HTTP between agents)
- **Technician stays separate** because it has a different lifecycle — it persists and improves across runs

### Pipeline Flow

1. **Plan** — Planner analyzes the brief, produces phases, tasks, architecture doc, constraints. Loads learned recipes for context.
2. **Build** — Builder implements each task in an isolated sandbox using tools from the registry.
3. **QA** — QA runs the code (read-only), verifies acceptance criteria, reports issues with evidence.
4. **Gate** — Gate decides: `go` (pass), `no-go` (fix and retry), or `escalate` (fail with diagnosis).
5. Retry loop runs up to 3 iterations per task before escalation.
6. **Learn** — On success, extracts recipes (architecture patterns, conventions) and saves them for future projects.

### The Learning Engine (Technician)

Kapow gets better over time. The technician maintains:

**Recipes** — Patterns learned from successful builds:
```
Run 1:  Builds a Next.js site → learns "App Router, Tailwind, /api/health"
Run 5:  Another Next.js site → skips architecture decisions, uses recipe
Run 20: Recipe refined by 15 builds → encodes patterns no prompt could capture
```

**Tools** — Reusable capabilities the builder can use:
```
Agent needs a capability → POST /request-tool
   ↓
Technician triages:
  ├── found_existing → return from registry
  ├── create_new → research → implement → test → publish
  ├── update_existing → enhance, bump version
  └── decouple → split into focused tools
```

Core tools (seeded on boot): `file_write`, `file_read`, `file_list`, `shell_exec`, `git_commit`, `github_create_repo`, `browser_navigate`, `browser_screenshot`, `vercel_deploy`, `netlify_deploy`

### AI Provider

Pluggable — switch between Anthropic and Gemini with one env var:

```bash
AI_PROVIDER=gemini    # or anthropic
```

| Role | Anthropic | Gemini |
|------|-----------|--------|
| Builder (strong) | Claude Opus | Gemini 2.5 Pro |
| Planner/QA (balanced) | Claude Sonnet | Gemini 2.5 Flash |
| Gate (fast) | Claude Haiku | Gemini 2.5 Flash |

### Database

Single PostgreSQL via `kapow-db` package (Prisma ORM).

**Global:** User, Recipe, Preference, Tool, Run, RunLog, RunArtifact
**Per-project:** Project, ProjectRecipe, ProjectPreference, Card, CardEvent

Recipes and preferences support **layering**: global defaults + per-project overrides.

## Installation

### Quick Start

```bash
git clone https://github.com/mondb-dev/kapow-builds.git
cd kapow-builds
npm install
npx tsx kapow.ts setup    # interactive wizard
```

The setup wizard handles: AI provider selection, Postgres (Docker/local/URL), auth secrets, GitHub OAuth, optional integrations.

### Manual Setup

```bash
cp .env.example .env      # edit with your keys
npx tsx kapow.ts install  # install all packages
npx tsx kapow.ts db:push  # create tables
npx tsx kapow.ts db:seed  # seed recipes, preferences, tools
npx tsx kapow.ts dev      # start 3 services
```

### Environment

```env
# AI (pick one)
AI_PROVIDER=gemini
GEMINI_API_KEY=...
# or
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kapow

# Auth
AUTH_SECRET=<openssl rand -base64 32>
INTERNAL_API_KEY=<openssl rand -hex 32>
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...

# Optional
GITHUB_TOKEN=ghp_...       # repo creation
VERCEL_TOKEN=...            # deploy to Vercel
NETLIFY_TOKEN=...           # deploy to Netlify
HELMSTACK_AGENT_URL=http://127.0.0.1:7070  # QA/Builder browser substrate (HelmStack)
```

### HelmStack Browser Substrate for QA

To run QA against a live browser substrate powered by HelmStack:

1. Run HelmStack desktop so its local agent server is up on `127.0.0.1:7070`.
2. Set `HELMSTACK_AGENT_URL=http://127.0.0.1:7070` in `.env`.
3. Restart Kapow services.

With that env var set, Kapow's `browser_navigate` and `browser_screenshot` tools route through HelmStack (used by Builder and QA) instead of launching local Puppeteer.

### QA-Only Website Audits (No Dev Work)

Kapow supports QA-only runs for existing websites. In your project brief, include a target URL and QA intent (responsiveness, usability, accessibility).

Example brief:

```text
QA-only website audit for https://example.com
Check responsiveness on mobile/tablet/desktop, usability of key flows, accessibility basics, and obvious performance/stability issues.
No code changes. Read-only QA only.
```

In QA-only mode, Kapow:

- skips Builder for that task
- runs browser-based QA checks (HelmStack-backed when configured)
- produces a downloadable CSV report artifact at `reports/<task-id>-qa-report.csv` for spreadsheet submission

### Start

```bash
npx tsx kapow.ts dev
```

```
  kapow-pipeline     → http://localhost:3000
  kapow-technician   → http://localhost:3006
  kapow-board        → http://localhost:3005
```

Open **http://localhost:3005** → sign in with GitHub → create a project.

### Commands

```bash
npx tsx kapow.ts setup       # Interactive setup wizard
npx tsx kapow.ts install     # Install all dependencies
npx tsx kapow.ts dev         # Start all services
npx tsx kapow.ts stop        # Stop all services
npx tsx kapow.ts status      # Show service status
npx tsx kapow.ts build       # Build all TypeScript
npx tsx kapow.ts db:push     # Push schema to DB
npx tsx kapow.ts db:seed     # Seed initial data
npx tsx kapow.ts db:studio   # Open Prisma Studio
```

## User Workflow

```
1. /board/projects → "+ New Project"

2. /board/projects/new
   ┌─────────────────────────────────────┐
   │ PROJECT NAME: CSU Campaign Website  │
   │                                     │
   │ BRIEF:                              │
   │ Built in React JS                   │
   │ Engaging frontpage with animations  │
   │ Blog archive and inner pages        │
   │ Generate and include images         │
   │                                     │
   │ ATTACHMENTS: wireframe.png (1.2MB)  │
   │                                     │
   │ [ Create Project & Plan Tasks ]     │
   └─────────────────────────────────────┘
        ↓ Kapow plans → creates cards

3. /board/projects/:id/kanban
   ┌───────┬────────┬──────┬──────┬───────┐
   │BACKLOG│IN PROG │  QA  │ DONE │FAILED │
   │       │        │      │      │       │
   │[Setup]│        │      │      │       │
   │[Front]│        │      │      │       │
   │[Blog] │        │      │      │       │
   │       │        │      │      │       │
   │  [⚡ Assign All to Kapow (3)]       │
   └───────┴────────┴──────┴──────┴───────┘
        ↓ Assign individually or all at once

4. Kapow builds → QA tests → Gate approves → Done
```

## Deployment

### Docker Compose

```bash
cp .env.example .env
docker compose up -d
```

Starts: pipeline + technician + board + PostgreSQL + Caddy (HTTPS).

### PM2

```bash
npx tsx kapow.ts install && npx tsx kapow.ts build
npx tsx kapow.ts db:push && npx tsx kapow.ts db:seed
pm2 start ecosystem.config.cjs
```

## Project Structure

```
kapow/
├── kapow.ts                    # CLI runner + setup wizard
├── package.json                # Root npm scripts
├── docker-compose.yml          # 3 services + Postgres + Caddy
├── Caddyfile                   # Reverse proxy (board public, agents internal)
├── Dockerfile.agent            # Multi-stage build for pipeline/technician
├── Dockerfile.board            # Board image
│
├── pipeline/                   # Consolidated pipeline (port 3000)
│   └── src/
│       ├── index.ts            # MCP server + HTTP entry
│       ├── orchestrator.ts     # Pipeline coordinator (direct function calls)
│       ├── http.ts             # HTTP API for board + SSE
│       ├── agents/
│       │   ├── planner.ts      # Plan generation
│       │   ├── builder.ts      # Code generation + tool loop
│       │   ├── qa.ts           # Read-only testing
│       │   ├── gate.ts         # Go/no-go decisions
│       │   └── sandbox.ts      # Isolated filesystem
│       └── tools/              # Shell, files, git, browser, deploy
│
├── technician/                 # Learning engine (port 3006)
│   └── src/
│       ├── researcher.ts       # Designs tool specifications
│       ├── implementer.ts      # Builds + tests tools
│       ├── request-handler.ts  # Triage: find/create/update/decouple
│       ├── doc-generator.ts    # Auto-generates documentation
│       └── registry.ts         # DB-backed tool registry
│
├── board/                      # Dashboard (port 3005)
│   ├── app/
│   │   ├── board/              # Kanban board
│   │   ├── board/projects/     # Project CRUD + creation wizard
│   │   ├── board/runs/         # Pipeline run history
│   │   ├── board/logs/         # Real-time agent log viewer
│   │   └── api/                # REST APIs + server actions
│   └── components/             # Board, Card, CardDetail, AssignAll
│
├── shared/                     # Shared types + AI provider + agent base
│   └── src/
│       ├── types.ts            # All cross-service interfaces
│       ├── agent-base.ts       # createAgent() factory
│       ├── persona.ts          # Kapow identity + voice lines
│       └── ai/                 # Pluggable AI (Anthropic + Gemini)
│
└── db/                         # Shared Prisma client
    ├── prisma/schema.prisma    # Single schema source of truth
    └── src/                    # Domain modules (recipes, tools, runs)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict, ES2022) |
| Runtime | Node.js 22 |
| AI | Anthropic Claude or Google Gemini (pluggable) |
| Orchestration | Model Context Protocol (MCP) |
| Database | PostgreSQL 16 + Prisma 6 |
| Board | Next.js 15, React 19, Tailwind CSS |
| Auth | NextAuth.js v5 (GitHub OAuth) |
| Git | `simple-git`, `@octokit/rest` |
| Browser | `puppeteer-core` (headless Chrome) |
| Deploy | Docker, Caddy, PM2 |

## License

MIT
