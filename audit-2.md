# Kapow System Audit 2

Date: 2026-03-19

## Scope

This pass covered:

- live process and port inspection
- direct health checks against running services
- current package build status
- runtime logs under `logs/`
- service-to-service contracts
- deployment and exposure model

## Executive Summary

Kapow is currently usable as a local dev stack, but not as a safe or coherent production system.

What is working now:

- `actions`, `planner`, `builder`, `qa`, `gate`, `technician`, `security`, and `comms` all answer health checks
- all of those services currently pass `npm run build`
- the pipeline core is alive in dev mode

What is not working cleanly:

- the included reverse proxy config exposes most agent APIs publicly with no auth
- the Docker deployment path is still broken
- the board is the weakest service: its dev process is unstable on `/health`, and its production build still fails
- the inter-agent bus exists, but most of the higher-level bus workflow is not actually wired into the runtime
- run persistence is only partially implemented, so the board’s run view cannot reflect real pipeline state reliably

## Live Runtime Snapshot

The following endpoints responded during this audit:

- `actions` on `3000`: `{"ok":true}`
- `planner` on `3001`: healthy
- `builder` on `3002`: healthy
- `qa` on `3003`: healthy
- `gate` on `3004`: healthy
- `technician` on `3006`: healthy, `10` tools ready
- `security` on `3007`: healthy
- `comms` on `3008`: healthy, webhook-only
- bus on `3010`: reachable

The bus is effectively idle at runtime:

- `/bus/status` returned `subscriptions: 1`
- `/bus/status` returned `agents: []`

That is materially inconsistent with the design docs and the presence of `builder/src/bus-integration.ts`, `qa/src/bus-integration.ts`, and `security/src/bus-integration.ts`.

## Build Snapshot

Current package builds:

- Pass: `shared`, `db`, `planner`, `builder`, `qa`, `gate`, `actions`, `technician`, `security`, `comms`
- Fail: `board`

Current `board` failure:

- `npm run build` fails during Next.js page-data collection for `/api/internal/cards/[cardId]/events`
- the same build also reports `/api/projects` page-data issues
- the board install also shows a broken `@next/swc-darwin-arm64` native binary fallback

## Findings

1. Critical: the proxy config exposes unauthenticated agent APIs to the outside world.

`Caddyfile` forwards `/api/planner/*`, `/api/builder/*`, `/api/qa/*`, `/api/gate/*`, `/api/technician/*`, `/api/security/*`, and `/api/comms/*` directly to the services, and forwards all remaining traffic to `actions`. The individual services only validate payload shape. They do not enforce auth, shared secrets, or internal-only checks. In practical terms, that means a public deployment would expose:

- direct planner invocation
- direct builder task execution
- direct QA/gate invocation
- technician tool creation endpoints
- the public `actions /pipeline` trigger

This is the single highest-risk issue in the current system because it turns internal agent machinery into public HTTP APIs.

2. Critical: the documented Docker deployment path is still broken.

`docker-compose.yml` builds each agent from its own directory context, while `Dockerfile.agent` only copies that package, runs `npm ci --omit=dev`, and then runs `npm run build`. That remains incompatible with this repo because:

- builds require TypeScript tooling from `devDependencies`
- multiple services depend on local sibling packages like `file:../shared` and `file:../db`

As written, the container path is not a viable production deployment method.

3. High: the inter-agent bus is mostly unimplemented in the live system.

The repo contains bus helper modules for builder, QA, and security, but the runtime evidence says they are not actually participating:

- `/bus/status` showed no registered agents
- I found no active imports that wire those bus-integration modules into service startup
- builder has code to request planner clarification and technician tools over the bus, but there are no matching consumers in planner or technician
- security has `startBusMonitoring()` but `security/src/index.ts` never starts it

The bus exists, but most of the “agents collaborate dynamically” design is dead code today.

4. High: run persistence is only partially wired, so the board’s run model is misleading.

The board now creates `Run` rows when cards are assigned to the agent, and `actions` now writes progress lines with `addRunLog()`. That is progress, but it is still incomplete:

- I found no callers for `updateRunStatus()`
- I found no callers for `addRunArtifact()`
- `actions /runs/:runId/status` falls back to DB logs only and returns `status: "unknown"` after restart
- `board/app/board/runs/page.tsx` expects `Run.status`, artifact counts, log counts, and card counts to represent reality

Result: the database contains runs, but their lifecycle state and artifact data are not being maintained end to end.

5. High: the security observer generates false negatives/false positives because its health contract with the board is wrong.

`security/src/observer.ts` probes every monitored service at `serviceUrl + "/health"`, including the board. The board does not expose a proper health endpoint, and `logs/security.log` shows repeated `Unhealthy services: board`. During this audit:

- board logs recorded repeated `GET /health 404`
- a direct request to `/health` also produced an internal error at one point due Next dev module resolution instability

So the security dashboard is currently mixing real health checks with a permanently broken board probe.

6. Medium: the board is the most operationally unstable service in the stack.

Current evidence:

- production build fails
- dev logs show repeated full reloads from runtime errors
- `/health` is not a supported route
- a direct `/health` request surfaced a missing-module error from `.next/server`

Even where the UI pages work interactively, the board process is not in a clean enough state to be treated as production-ready.

7. Medium: QA safety depends on external runtime configuration, not just code.

The code in `qa/src/tool-dispatch.ts` defaults to broader permissions than the current running QA process is using, but `logs/qa.log` shows the live process started with `allowed: read`. That means the current local runtime is safer than the code default would suggest. The risk here is configuration drift:

- local runtime is read-only today
- future environments can silently become more permissive if the env contract is not enforced

## Agent-by-Agent Notes

- `actions`: healthy and buildable; still publicly triggerable and still only partially integrated with persistent run state.
- `planner`: healthy and buildable; exposed publicly through Caddy with no auth.
- `builder`: healthy and buildable; exposed publicly through Caddy with no auth; bus-based escalation paths are not actually wired.
- `qa`: healthy and buildable; current runtime appears read-only; bus integration module exists but is not active.
- `gate`: healthy and buildable; exposed publicly through Caddy with no auth.
- `technician`: healthy and buildable; registry seeded; direct tool-management endpoints are exposed publicly through Caddy with no auth.
- `security`: healthy and buildable; observer is running; bus monitoring exists in code but is not started; board health checks are currently noisy and misleading.
- `comms`: healthy and buildable; webhook-only in current runtime because Slack credentials are not loaded.
- `board`: partly working in dev, but still the main deployment/runtime problem area.

## Process Notes

- The stack is running in dev form (`tsx` / `next dev`), not as production `dist` processes.
- `logs/*.log` contain useful startup evidence, but pidfile/process tracking is not fully reliable anymore because the current board process is not the same PID as the old pidfile entry.
- Security’s repeated “board unhealthy” warnings are log noise right now, not a clean signal.

## Recommended Remediation Order

1. Lock down exposure first.
   Remove public access to internal agent routes or add real auth for every internal API.

2. Fix the deployment model.
   Rework Docker/image assembly so shared packages and build-time dependencies are available.

3. Finish run persistence.
   Wire `updateRunStatus()` and `addRunArtifact()` into the actual pipeline, not just log writes.

4. Make the bus real or remove it from the design.
   Either start the bus integrations and add consumers, or delete the dead workflow claims.

5. Fix board operational hygiene.
   Add a real `/health` endpoint, stabilize the dev server, and make `npm run build` pass.

6. Make security signals trustworthy.
   Stop probing nonexistent endpoints and start only the health checks that reflect real service contracts.

## Bottom Line

The local developer experience is ahead of the production architecture. The core pipeline can run, but the deployment surface, board reliability, and inter-agent collaboration model are still materially behind the design being advertised by the repo.
