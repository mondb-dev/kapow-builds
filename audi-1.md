# Kapow System Audit 1

Date: 2026-03-19

## Findings

1. Critical: the documented container deployment path is broken. `docker-compose.yml` builds each agent from its own service directory, while `Dockerfile.agent` only copies that package, runs `npm ci --omit=dev`, then `npm run build`. That fails for two reasons: agent builds need `typescript` from `devDependencies`, and several packages depend on local `file:../shared` / `file:../db` packages that are outside the build context, e.g. `actions/package.json` and `technician/package.json`. As written, Docker and PM2 style production deployment are not viable.

2. Critical: the technician tool-registry flow is broken in source. It treats async DB calls as synchronous arrays in `technician/src/request-handler.ts`, `technician/src/researcher.ts`, and `technician/src/doc-generator.ts`. `npm run build` fails there, so the “agent requests tool, technician researches/builds/publishes it” loop is not production-capable.

3. Critical: security is both uncompilable and absent at runtime. `security/src/index.ts` builds a dashboard from DB return types that do not match the declared API types, and `security/src/scanner.ts` pushes unresolved promises into `alerts` instead of awaited alert records. In the live process snapshot, ports `3000-3006` and `3008` were listening, but `3007` was not, so the advertised observer layer is currently down.

4. High: run state is ephemeral. `actions/src/http.ts` and `actions/src/index.ts` keep pipeline state in process-local maps with TTL cleanup. A durable run store exists in `db/src/runs.ts`, but I found no callers. Any `actions` restart loses pipeline status, logs, and artifacts.

5. High: the board duplicates progress into the database on every reconnect. In `board/app/api/runs/[runId]/progress/route.ts`, `lastMessageCount` starts at `0` per request, then every fetched message is inserted as a new `cardEvent`. Multiple viewers or reconnects will duplicate the full history.

6. High: the bus can drop unread messages. `actions/src/bus-api.ts` returns a slice of an agent inbox, then clears the entire inbox. Overlapping polls, reconnects, or missed `afterId` positions can lose events.

7. High: QA is not actually read-only. The QA prompt says that explicitly in `qa/src/qa.ts`, but the default permissions include `execute` in `qa/src/tool-dispatch.ts`, and `shell_exec` is registered there. Since that is arbitrary `bash -c`, QA can mutate the sandbox and invalidate the builder/QA separation.

8. Medium: the browser screenshot tool can write outside the sandbox. `builder/src/tools/browser.ts` uses `join(sandboxPath, filename)` instead of the sandbox path resolver used by the file tools, so path traversal like `../../foo.png` is not blocked there.

## Live Snapshot

On 2026-03-19, the live listeners found were:

- `actions` on `3000` and bus `3010` as a `tsx src/index.ts` dev process.
- `planner` on `3001`, `builder` on `3002`, `qa` on `3003`, `gate` on `3004`, `technician` on `3006`, and `comms` on `3008`, all running as `tsx` dev processes.
- `board` on `3005` as `next dev`.
- `security` was not listening on `3007`.

## Build Status

Builds pass:

- `shared`
- `db`
- `planner`
- `builder`
- `qa`
- `gate`

Builds fail:

- `actions` due to missing `express` typing/declaration coverage for its bus server files
- `technician`
- `security`
- `comms`
- `board` due to the `assigneeId` type mismatch in `board/components/CardDetail.tsx`

## Immediate Fixes

1. Restore build integrity for all services.
   Fix `actions`, `technician`, `security`, `comms`, and `board` until `npm run build` passes in every package.

2. Bring `security` back into the runtime.
   Fix the type and async issues, then verify port `3007` is listening and integrated into the current dev stack.

3. Stop data loss in `actions`.
   Move run state, progress logs, and artifacts out of in-memory maps and into the existing DB-backed run model.

4. Stop event duplication in the board.
   Make `board/app/api/runs/[runId]/progress/route.ts` idempotent so reconnects and multiple viewers do not create duplicate `cardEvent` rows.

5. Lock QA back down to read-only behavior.
   Remove or constrain arbitrary shell execution in QA, or split verification commands into a narrower non-mutating execution layer.

6. Fix sandbox boundary enforcement in browser tools.
   Route screenshot output paths through the same sandbox resolver used by file tools.

## Deployment Blockers

- The Docker build path is broken because agent images are built from per-service contexts while depending on sibling local packages.
- `Dockerfile.agent` installs with `--omit=dev` and then runs TypeScript builds, which requires dev tooling that is not installed.
- `actions` does not currently build cleanly, so the orchestrator and bus are not production-build ready.
- `technician` does not build cleanly, so dynamic tool management is not production-build ready.
- `security` does not build cleanly and is not currently running, so the monitoring layer is absent.
- `comms` does not build cleanly, so Slack/webhook integration is not production-build ready.
- `board` does not build cleanly, so the UI is not production-build ready.
- Run tracking is in-memory in `actions`, so restarts lose operational state even if the service starts.

## Recommended Remediation Order

1. Fix package build failures first.
   Start with `actions`, `technician`, `security`, `comms`, and `board`. Until builds are green, every later deployment or runtime change stays unstable.

2. Repair the deployment model.
   Redesign Docker build contexts and image assembly so shared packages are available during install/build, and ensure build-time dependencies are present.

3. Stabilize orchestration state.
   Wire `actions` into the DB-backed run, log, and artifact tables so pipeline execution survives process restarts.

4. Restore observability and controls.
   Bring `security` back online, verify health monitoring, and confirm the observer is part of the actual dev and deploy workflows.

5. Fix message and event correctness.
   Address bus message loss and board event duplication so operators can trust the system state they are seeing.

6. Re-establish execution boundaries.
   Make QA truly read-only and fix browser sandbox path handling so the agent roles match their intended trust model.

7. Then do end-to-end validation.
   Run a real pipeline through planner, builder, QA, gate, board, technician, comms, and security with persistence enabled and confirm the full loop works after restart scenarios.

## Bottom Line

The healthy core today is `planner -> builder -> qa -> gate` in dev mode. The system-level gaps are around deployability, observability, and the side services: `actions` persistence, `technician`, `security`, `comms`, and `board` production build integrity.

I could not validate the live HTTP endpoints directly from the sandbox because local socket calls were blocked there, so runtime verification came from process and port inspection plus local builds.
