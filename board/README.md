# kapow-board

Kanban-style project management board for humans and AI agents. Cards can be assigned to yourself or to the Kapow Agent, which triggers the kapow-actions pipeline and streams real-time progress back into the card's activity log.

## Stack

- Next.js 15 (App Router, TypeScript)
- Prisma + PostgreSQL
- NextAuth.js v5 (GitHub OAuth)
- Tailwind CSS
- Server-Sent Events for real-time updates

## Prerequisites

- Node.js 20+
- PostgreSQL (local or remote)
- A GitHub OAuth App (for authentication)
- `kapow-actions` running on port 3000

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/kapow_board"
AUTH_SECRET="run: openssl rand -base64 32"
AUTH_GITHUB_ID="your-github-oauth-app-client-id"
AUTH_GITHUB_SECRET="your-github-oauth-app-client-secret"
KAPOW_ACTIONS_URL="http://localhost:3000"
NEXT_PUBLIC_APP_URL="http://localhost:3001"
```

**GitHub OAuth App settings:**
- Homepage URL: `http://localhost:3001`
- Authorization callback URL: `http://localhost:3001/api/auth/callback/github`

Create one at: https://github.com/settings/developers

### 3. Push the database schema

```bash
npm run db:push
```

### 4. Run the dev server

```bash
npm run dev
```

Board runs at http://localhost:3001. Sign in with GitHub.

## Usage

### Creating cards

Click the `+` button on the Backlog column header. Enter a title and a description. The description is the full plan text sent to the Kapow Agent if you assign to it.

### Assigning to the Kapow Agent

Either check "Assign to Kapow Agent immediately" when creating the card, or open the card detail and click "Assign to Agent". This POSTs to `kapow-actions` at `KAPOW_ACTIONS_URL/pipeline` with the card's description as the plan, then streams progress events back into the activity log via SSE.

### Assigning to yourself

Click "Assign to me" on the card detail page.

### Moving cards

Drag and drop cards between columns. The status is persisted immediately.

## kapow-actions integration

The board expects `kapow-actions` to expose:

| Endpoint | Description |
|---|---|
| `POST /pipeline` | Start a pipeline. Body: `{ runId, plan }`. Returns `{ runId }`. |
| `GET /runs/:runId/status` | Poll status. Returns `{ status, messages[] }`. |
| `GET /runs/:runId/stream` | SSE stream of progress events. |

The HTTP server (`kapow-actions/src/http.ts`) is started automatically alongside the MCP stdio server when `kapow-actions` boots.

## Other scripts

```bash
npm run db:studio    # Open Prisma Studio (DB browser)
npm run build        # Production build
npm run start        # Start production server on port 3001
```
