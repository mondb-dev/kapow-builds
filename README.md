# Kapow

Multi-agent AI development pipeline. Describe what you want to build — in Slack, a browser, or Claude Desktop — and Kapow plans, builds, tests, and ships it.

## Architecture

```
                           ┌──────────────────┐
                           │     User Input    │
                           └────────┬─────────┘
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
              │   Slack    │  │   Board   │  │    MCP    │
              │  @kapow    │  │   (UI)    │  │  (Claude) │
              │  :3008     │  │  :3005    │  │  (stdio)  │
              └─────┬──────┘  └─────┬─────┘  └─────┬─────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
                           ┌────────▼────────┐
                           │   Actions       │
                           │   Orchestrator  │
                           │   :3000 (MCP)   │
                           └────────┬────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
     ┌────────▼────────┐           │            ┌────────▼────────┐
     │   Technician    │           │            │    Security     │
     │   Tool Maker    │           │            │    Observer     │
     │   :3006         │           │            │    :3007        │
     └────────┬────────┘           │            └─────────────────┘
              │                    │
              │ tools     ┌────────▼────────┐
              └──────────►│                 │
                          │  Pipeline Loop  │
                          │                 │
                          │  ┌───────────┐  │
                          │  │  Planner  │  │  :3001 — Claude Sonnet
                          │  │     ↓     │  │
                          │  │  Builder  │  │  :3002 — Claude Opus + tools
                          │  │     ↓     │  │
                          │  │    QA     │  │  :3003 — Claude Sonnet (read-only)
                          │  │     ↓     │  │
                          │  │   Gate    │  │  :3004 — Claude Haiku
                          │  │   ↓   ↓  │  │
                          │  │  go  no-go│  │  ← retry up to 3x
                          │  └───────────┘  │
                          └─────────────────┘
                                    │
                           ┌────────▼────────┐
                           │    PostgreSQL    │
                           │    (shared)      │
                           └─────────────────┘
```

### Services

| Service | Port | Model | Role |
|---------|------|-------|------|
| **actions** | 3000 | — | MCP orchestrator, pipeline coordinator |
| **planner** | 3001 | Claude Sonnet | Analyzes briefs, produces phased task plans with architecture docs |
| **builder** | 3002 | Claude Opus | Implements tasks in a sandboxed filesystem using tools from the registry |
| **qa** | 3003 | Claude Sonnet | Read-only testing — runs builds, tests, verifies acceptance criteria |
| **gate** | 3004 | Claude Haiku | Go/no-go/escalate decisions per task |
| **board** | 3005 | — | Next.js 15 dashboard — Kanban board, projects, runs, security |
| **technician** | 3006 | Claude Sonnet | Tool specialist — researches, builds, tests, and documents tools |
| **security** | 3007 | Claude Sonnet | Pipeline observer — health monitoring, secret scanning, audit log |
| **comms** | 3008 | Claude Haiku | Slack bot + webhook API for conversational project scoping |

### Pipeline Flow

1. **Plan** — Planner produces phases, tasks, architecture doc, and constraints
2. **Build** — Builder implements each task in a sandbox using tools from the registry
3. **QA** — QA runs the code, verifies acceptance criteria, reports issues
4. **Gate** — Gate decides: `go` (pass), `no-go` (fix and retry), or `escalate` (fail)
5. Retry loop runs up to 3 iterations per task before escalation

### Tool Layer

Agents don't have hardcoded tools. They request capabilities from the **technician**:

```
Agent needs a capability
        ↓
POST /request-tool { need: "...", context: "..." }
        ↓
Technician triages (Claude Sonnet):
  ├── found_existing → return tool from registry
  ├── create_new → research → implement → test → publish
  ├── update_existing → enhance tool, bump version
  └── decouple → split complex tool into focused ones
        ↓
Tool published with auto-generated docs
All agents can use it
```

Core tools (seeded on boot): `file_write`, `file_read`, `file_list`, `shell_exec`, `git_commit`, `github_create_repo`, `browser_navigate`, `browser_screenshot`, `vercel_deploy`, `netlify_deploy`

### Database

Single PostgreSQL instance, shared via the `kapow-db` package (Prisma ORM).

**Global scope** — shared across all projects:
- `User` — GitHub OAuth users
- `Recipe` — Learned patterns from successful builds
- `Preference` — Default tech stack choices
- `Tool` — Tool registry (managed by technician)
- `SecurityAlert`, `AuditEntry` — Security data
- `Conversation` — Slack thread state

**Project scope** — scoped per project:
- `Project` — Name, description, repo URL
- `ProjectRecipe` — Per-project recipe overrides
- `ProjectPreference` — Per-project preference overrides
- `Run` — Pipeline executions
- `RunLog` — Progress stream per run
- `RunArtifact` — Build outputs
- `Card`, `CardEvent` — Kanban task tracking

Recipes and preferences support **layering**: global defaults + per-project overrides that merge on top.

### Comms (Slack Integration)

Tag `@kapow` in any Slack channel to start a conversation:

```
You:    @kapow Create a REST API for user management with auth and Postgres
Kapow:  Got it. Let me analyze the scope and create a detailed plan...

        *Architecture*
        > REST API with Express, Prisma, JWT...
        *Phases (3):*
        *Setup* — project scaffolding
          • Initialize TypeScript project
            ✓ package.json with all dependencies
          • Set up Prisma with User model
        ...
        What do you think?

You:    Add rate limiting to the auth endpoints
Kapow:  Got it, revising the plan with your changes...
        [updated plan]

You:    looks good, ship it
Kapow:  Plan approved. Starting the build pipeline...
        Pipeline started (run: slack-xyz123)

        > [slack-xyz123] Starting planner...
        > [slack-xyz123] Planner complete. 3 phases, 8 tasks.
        > [slack-xyz123] Building task setup-1...
        ...

Kapow:  Build complete! All tasks passed.
```

State machine: `idle → scoping → planning → negotiating → confirmed → building → done/failed`

## Installation

### Prerequisites

- **Node.js 22+** (LTS)
- **PostgreSQL 16+** (local or Docker)
- **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com))

### 1. Clone

```bash
git clone https://github.com/mondb-dev/kapow-builds.git
cd kapow-builds
```

### 2. Environment

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kapow

# GitHub OAuth (for board login)
AUTH_SECRET=generate-a-random-string
AUTH_GITHUB_ID=your-github-oauth-app-id
AUTH_GITHUB_SECRET=your-github-oauth-app-secret

# Optional — builder integrations
GITHUB_TOKEN=ghp_...
VERCEL_TOKEN=...
NETLIFY_TOKEN=...

# Optional — Slack bot
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

# Optional — deployment
KAPOW_DOMAIN=localhost
POSTGRES_PASSWORD=postgres
```

### 3. Install dependencies

```bash
npm install              # root deps (tsx, dotenv)
npx tsx kapow.ts install # all services (db first, then agents + board)
```

### 4. Set up database

```bash
# Start Postgres (if not running)
# Option A: Docker
docker run -d --name kapow-pg -p 5432:5432 \
  -e POSTGRES_DB=kapow \
  -e POSTGRES_PASSWORD=postgres \
  postgres:16-alpine

# Option B: local Postgres
createdb kapow

# Push schema and seed
npx tsx kapow.ts db:push
npx tsx kapow.ts db:seed
```

### 5. Start

```bash
npx tsx kapow.ts dev
```

All 9 services start in the background:

```
  planner      → http://localhost:3001
  builder      → http://localhost:3002
  qa           → http://localhost:3003
  gate         → http://localhost:3004
  technician   → http://localhost:3006
  security     → http://localhost:3007
  comms        → http://localhost:3008
  actions      → http://localhost:3000
  board        → http://localhost:3005
```

Open **http://localhost:3005** to access the board.

### Commands

```bash
npx tsx kapow.ts install     # Install all dependencies
npx tsx kapow.ts dev         # Start all services
npx tsx kapow.ts stop        # Stop all services
npx tsx kapow.ts status      # Show service status
npx tsx kapow.ts build       # Build all TypeScript
npx tsx kapow.ts db:migrate  # Run Prisma migrations
npx tsx kapow.ts db:push     # Push schema (no migration files)
npx tsx kapow.ts db:seed     # Seed recipes, preferences, core tools
npx tsx kapow.ts db:studio   # Open Prisma Studio GUI
```

Or use npm scripts:

```bash
npm run dev
npm run stop
npm run status
npm run db:push
npm run db:seed
```

## Deployment

### Docker Compose (recommended)

```bash
cp .env.example .env
# Edit .env with production values

docker compose up -d
```

This starts all 9 services + PostgreSQL + Caddy (HTTPS reverse proxy). Set `KAPOW_DOMAIN` in `.env` to your domain.

### PM2 (bare metal)

```bash
npx tsx kapow.ts install
npx tsx kapow.ts build
npx tsx kapow.ts db:push
npx tsx kapow.ts db:seed

pm2 start ecosystem.config.cjs
```

### Slack Bot Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** (for development) or configure an **Event Subscriptions URL** (`https://your-domain/api/comms/slack/events`)
3. Add bot scopes: `app_mentions:read`, `chat:write`, `users:read`, `commands`
4. Subscribe to events: `app_mention`, `message.channels`, `message.groups`
5. Optionally add slash command: `/kapow`
6. Install to workspace and copy tokens to `.env`

### GitHub OAuth Setup (for board)

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → OAuth Apps → New
2. Set callback URL to `http://localhost:3005/api/auth/callback/github` (or your production URL)
3. Copy Client ID and Client Secret to `.env`

## Project Structure

```
kapow/
├── kapow.ts                    # CLI runner (replaces shell scripts)
├── package.json                # Root — npm scripts delegate to kapow.ts
├── docker-compose.yml          # Full stack orchestration
├── ecosystem.config.cjs        # PM2 config for bare metal
├── Caddyfile                   # Reverse proxy routes
├── Dockerfile.agent            # Generic agent image
├── Dockerfile.board            # Board-specific image
│
├── db/                         # Shared database package
│   ├── prisma/schema.prisma    # Single source of truth for all models
│   └── src/                    # Domain modules (recipes, tools, security, runs, etc.)
│
├── actions/                    # MCP orchestrator (port 3000)
│   └── src/
│       ├── index.ts            # MCP server (execute_plan, pipeline_status)
│       ├── orchestrator.ts     # Pipeline coordinator
│       └── http.ts             # HTTP API for board integration + SSE
│
├── planner/                    # Planning agent (port 3001)
│   └── src/planner.ts          # Claude Sonnet — produces ProjectPlan
│
├── builder/                    # Build agent (port 3002)
│   └── src/
│       ├── builder.ts          # Claude Opus — tool-use agent loop
│       ├── sandbox.ts          # Isolated filesystem per run
│       └── tools/              # Local tool implementations
│
├── qa/                         # QA agent (port 3003)
│   └── src/qa.ts               # Claude Sonnet — read-only verification
│
├── gate/                       # Gate agent (port 3004)
│   └── src/gate.ts             # Claude Haiku — go/no-go decisions
│
├── board/                      # Next.js 15 dashboard (port 3005)
│   ├── app/
│   │   ├── board/              # Kanban board
│   │   ├── board/projects/     # Project list
│   │   ├── board/runs/         # Pipeline run history
│   │   ├── board/security/     # Security dashboard
│   │   └── api/                # Card CRUD, auth, events
│   └── components/             # Board, Card, CardDetail, AddCardModal
│
├── technician/                 # Tool specialist (port 3006)
│   └── src/
│       ├── researcher.ts       # Research agent — designs tool specs
│       ├── implementer.ts      # Build agent — implements + tests tools
│       ├── request-handler.ts  # Triage: find/create/update/decouple
│       ├── doc-generator.ts    # Auto-generates tool documentation
│       └── registry.ts         # DB-backed tool registry
│
├── security/                   # Pipeline observer (port 3007)
│   └── src/
│       ├── observer.ts         # Health monitor (30s interval)
│       ├── auditor.ts          # Pattern-based secret/command scanning
│       └── scanner.ts          # AI-powered deep security analysis
│
├── comms/                      # Communications layer (port 3008)
│   └── src/
│       ├── slack.ts            # Slack Bolt bot (@mentions, threads)
│       ├── handler.ts          # Conversation state machine
│       ├── intent.ts           # Claude Haiku intent classifier
│       └── conversations.ts    # Thread state persistence
│
├── tool-client/                # Shared tool discovery library
│   └── src/client.ts           # ToolClient — any agent imports this
│
└── data/                       # Legacy seed data (migrated to DB)
    ├── recipes.json
    └── preferences.json
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode, ES2022) |
| Runtime | Node.js 22 |
| AI | Claude API via `@anthropic-ai/sdk` |
| Orchestration | Model Context Protocol (MCP) |
| Database | PostgreSQL 16 + Prisma 6 |
| Board UI | Next.js 15, React 19, Tailwind CSS |
| Auth | NextAuth.js v5 (GitHub OAuth) |
| Slack | `@slack/bolt` (Socket Mode + HTTP) |
| Git | `simple-git`, `@octokit/rest` |
| Browser | `puppeteer-core` (headless Chrome) |
| Deploy | Docker, Caddy, PM2 |

## License

MIT
