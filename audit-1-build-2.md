# Audit: Build 2

Date: 2026-03-20

## Scope

Audit of the current checked-in "new build" centered on the 3-service architecture described in the repository:
- `pipeline`
- `technician`
- `board`

This pass focused on:
- current source wiring
- build integrity
- deployment consistency
- runtime path consistency between README, launcher, PM2, Docker Compose, and board flows

## Verification Performed

- Verified the worktree was clean.
- Ran the top-level build path with `npm run build`.
- Built `pipeline`, `technician`, and `board` directly.
- Reviewed:
  - `kapow.ts`
  - `README.md`
  - `docker-compose.yml`
  - `Caddyfile`
  - `ecosystem.config.cjs`
  - `pipeline` runtime and orchestration code
  - board project creation and run-progress routes

Notes:
- The root build needed to be run outside the sandbox because `tsx` IPC binding was blocked inside the sandbox.
- I did not run a fresh end-to-end live flow in this pass because the stack was stopped during the audit.

## Findings

### 1. Critical: new-project planning flow still depends on the old standalone planner service

The main project creation flow is still wired to the old planner service:

- `board/app/board/projects/new/page.tsx` posts to `/api/projects/:id/plan`
- `board/app/api/projects/[projectId]/plan/route.ts` calls `PLANNER_URL` and defaults to `http://localhost:3001`

But the new launcher only starts:
- `pipeline`
- `technician`
- `board`

This is defined in `kapow.ts`, and Docker Compose also only defines those services.

Impact:
- under the advertised 3-service architecture
- `Create Project & Plan Tasks` will fail
- project creation is therefore not operational in the primary UI flow

Relevant files:
- `/Users/mondb/Documents/Projects/kapow/board/app/board/projects/new/page.tsx`
- `/Users/mondb/Documents/Projects/kapow/board/app/api/projects/[projectId]/plan/route.ts`
- `/Users/mondb/Documents/Projects/kapow/kapow.ts`
- `/Users/mondb/Documents/Projects/kapow/docker-compose.yml`

### 2. Critical: PM2 production path is still the old 9-service topology

The documented build path now compiles the 3-service architecture:
- `shared`
- `db`
- `tool-client`
- `pipeline`
- `technician`
- `board`

But `ecosystem.config.cjs` still starts the old fleet:
- `planner`
- `builder`
- `qa`
- `gate`
- `technician`
- `comms`
- `security`
- `actions`
- `board`

Since `dist/` is gitignored, a clean machine following the current PM2 path is depending on a runtime layout that the new top-level build command does not target.

Impact:
- PM2 deployment is architecture-inconsistent
- operators can follow the README and still end up with broken or partial startup behavior

Relevant files:
- `/Users/mondb/Documents/Projects/kapow/kapow.ts`
- `/Users/mondb/Documents/Projects/kapow/ecosystem.config.cjs`
- `/Users/mondb/Documents/Projects/kapow/.gitignore`

### 3. High: Docker/Compose deployment is not self-contained

The README says `docker compose up -d` is sufficient.

But:
- Compose does not run schema push or seeding for a fresh database
- there is no init job for Prisma setup
- Caddy still routes `/api/comms/*` to `comms:3008`
- Compose does not define a `comms` service

Impact:
- fresh deployments can start against an uninitialized database
- one documented public proxy path is dead at deploy time

Relevant files:
- `/Users/mondb/Documents/Projects/kapow/README.md`
- `/Users/mondb/Documents/Projects/kapow/docker-compose.yml`
- `/Users/mondb/Documents/Projects/kapow/Caddyfile`

### 4. High: pipeline artifact aggregation regressed for multi-task runs

Inside the consolidated pipeline orchestrator, successful task artifacts overwrite the accumulator:

- `allArtifacts = buildResult.artifacts`

instead of appending.

The final `PipelineResult` therefore returns only the last successful task’s artifacts, not the full run artifact set.

Impact:
- incorrect run results
- truncated artifact reporting
- downstream UI or integrations can present incomplete outputs for multi-task runs

Relevant file:
- `/Users/mondb/Documents/Projects/kapow/pipeline/src/orchestrator.ts`

### 5. Medium: technician still binds publicly instead of respecting localhost-only host config

The launcher passes `HOST=127.0.0.1`, but `technician` calls:

- `app.listen(PORT)`

without passing a host.

Impact:
- `technician` can still bind on all interfaces
- the localhost-only hardening is incomplete in the new 3-service model

Relevant files:
- `/Users/mondb/Documents/Projects/kapow/kapow.ts`
- `/Users/mondb/Documents/Projects/kapow/technician/src/index.ts`

### 6. Medium: board still exposes a security page that depends on a service the new launcher no longer starts

The board navigation still links to `/board/security`, and that page fetches:

- `SECURITY_URL`
- defaulting to `http://localhost:3007`

But the new 3-service launcher does not start `security`.

Impact:
- dead admin surface in the current architecture
- misleading operational UI
- documentation and product behavior remain split between old and new models

Relevant files:
- `/Users/mondb/Documents/Projects/kapow/board/app/board/page.tsx`
- `/Users/mondb/Documents/Projects/kapow/board/app/board/security/page.tsx`
- `/Users/mondb/Documents/Projects/kapow/kapow.ts`

## Build Status

Observed during this pass:

- top-level `npm run build`: passed
- `pipeline` build: passed
- `technician` build: passed
- `board` build: passed

Board build note:
- `next build` emitted repeated warnings about loading `@next/swc-darwin-arm64`
- it still completed successfully using the wasm fallback

## Bottom Line

The new build compiles, but the system is not fully migrated.

The core problem is not TypeScript integrity. The core problem is architectural drift:
- the 3-service runtime exists
- but key user flows, deployment paths, and admin surfaces still assume the old 9-service world

The highest-priority fixes are:
1. move board planning to the consolidated `pipeline` path
2. align PM2 with the new 3-service topology
3. make Docker Compose self-initializing and remove dead `comms` routing
4. fix artifact accumulation in `pipeline`
5. bind `technician` to the configured host
6. remove or rework security/comms surfaces that no longer belong to the new architecture
