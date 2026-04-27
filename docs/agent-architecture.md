# Kapow Agent Architecture

How planner, builder, QA, gate, and technician fit together — and how tools flow between them.

## Principles

- **AGENTS.md = static.** Each agent's role, decision rules, and output schema live in a markdown file next to its code. Rarely changes.
- **SKILLS.md = dynamic.** Each agent's tool manifest is generated at run start from technician's registry, and hot-patched mid-run when new tools are published.
- **Technician owns tools.** It researches, writes, tests, and publishes them. No tool reaches an agent without passing tests in a sandbox.
- **Pull, not push.** Technician never injects unsolicited. Agents request tools through the orchestrator; technician answers.
- **One external HTTP hop.** Pipeline → Technician. Everything else inside the pipeline is a function call.

## Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              KAPOW PIPELINE                                  │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────┐      │
│   │                      ORCHESTRATOR (pipeline:3000)                 │      │
│   │   • runs agents in sequence  • owns the run state                 │      │
│   │   • exposes requestTool(need, role) to all agents                 │      │
│   └──────────────────────────────────────────────────────────────────┘      │
│         │              │              │              │                       │
│         ▼              ▼              ▼              ▼                       │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐                 │
│   │ PLANNER  │──▶│ BUILDER  │──▶│    QA    │──▶│   GATE   │── pass ──▶ done│
│   │          │   │          │   │          │   │          │                 │
│   │ AGENTS.md│   │ AGENTS.md│   │ AGENTS.md│   │ (rules,  │                 │
│   │ SKILLS.md│   │ SKILLS.md│   │ SKILLS.md│   │  no LLM) │                 │
│   └──────────┘   └──────────┘   └──────────┘   └──────────┘                 │
│         │              │              │              │                       │
│         │              │              │              └── fail ──┐           │
│         │              │              │                         │           │
│         │              │              └──── retry (≤3) ◀────────┘           │
│         │              │                                                     │
│         │       ToolRequest{need, context, role}                             │
│         ▼              ▼              ▼                                      │
│   ═══════════════════════════════════════════════════════                   │
│              SKILLS.md = generated from technician                           │
│              AGENTS.md = static role/behavior contract                       │
│   ═══════════════════════════════════════════════════════                   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │  HTTP (the only external dep)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TECHNICIAN  (service :3006)                           │
│                        "tool factory + registry"                             │
│                                                                              │
│   ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐      │
│   │  RESEARCH  │───▶│   WRITE    │───▶│   TEST     │───▶│  PUBLISH   │      │
│   │  (find or  │    │ tool.ts +  │    │  sandbox   │    │ to registry│      │
│   │   design)  │    │ tool.test  │    │  must pass │    │ + SKILL.md │      │
│   └────────────┘    └────────────┘    └────────────┘    └────────────┘      │
│                                              │                               │
│                                              ▼ fail → ToolRequest.failed     │
│                                                                              │
│   Registry:  tools/<name>/{tool.ts, tool.test.ts, SKILL.md, version}        │
│   API:       GET /tools?role=…    GET /tools/:name    POST /tools/request    │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  Postgres (db)   │
                          │ Recipes • Tools  │
                          │ Projects • Runs  │
                          └──────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          BOARD (Next.js :3005)                               │
│                kanban • runs • logs   ──▶ pipeline:3000 HTTP                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File layout

```
pipeline/src/agents/
  planner/
    AGENTS.md       # role, decision rules, output schema
    SKILLS.md       # tool manifest (generated; checked-in copy is the fallback cache)
    index.ts        # loader: reads md → builds prompt → LLM call
  builder/
    AGENTS.md
    SKILLS.md
    index.ts
  qa/
    AGENTS.md
    SKILLS.md
    index.ts
  gate.ts           # rules only, no LLM, no md

technician/
  tools/<tool-name>/
    tool.ts         # implementation
    tool.test.ts    # safety + behavior tests
    SKILL.md        # per-tool card: name, inputs, outputs, when-to-use, safety notes
    version         # semver, pinned per run
  registry.ts       # serves /tools, /tools/:name, /tools/:name/skill.md
  pipeline/         # research → write → test → publish stages
```

## How a run hydrates prompts

1. Orchestrator starts a run.
2. For each agent (planner, builder, QA), it:
   - reads `AGENTS.md` (static)
   - calls `GET /tools?role=<agent>` on technician
   - concatenates the returned `SKILL.md` cards into the agent's `SKILLS.md` for this run
   - pins tool versions for the run
3. The combined `AGENTS.md + SKILLS.md` becomes the system prompt.

If technician is unreachable at boot, the on-disk `SKILLS.md` cache is used and a warning is logged. Background refresh retries until it succeeds.

## Mid-build tool requests

Builder (or any agent) can request a new tool mid-run:

```
builder hits a gap → emits ToolRequest{need, context, role:"builder"}
  → orchestrator forwards to technician
  → technician: search registry → if miss, research + write + test
  → tests pass → publish + return SKILL.md card + handle
  → orchestrator hot-patches builder's SKILLS.md
  → builder retries the step on its next LLM turn
```

### Safety rules

1. **Pull-only.** Technician acts only on a `ToolRequest`. No unsolicited injection. Runs stay replayable.
2. **Tests gate publish.** Even mid-build. Test failure → `ToolRequest.failed` → builder falls back (re-scope via planner, or block the card). No "skip tests" path.
3. **Per-run budget.** Max 3 mid-build tool creations per run. Past the cap, technician refuses and the run fails loud — prevents tool-invention spirals.
4. **Version pin per run.** New tool versions never replace tools an agent is already using. They apply to the next run.
5. **Technician writes only to its registry.** Never to project code. Builder is the only agent that touches the project repo.

## Recipes vs tools

**Recipes = planning heuristics only.** They shape *which cards the planner creates and in what order* — not how to implement them. Stored as text, retrieved via pgvector RAG, injected into the planner prompt only.

**Tools = how to do things.** Deterministic, tested, versioned, owned by technician. Used by builder and QA.

| Recipe (planner only) | Tool (builder / QA) |
|---|---|
| "Auth before billing for SaaS" | "Scaffold NextAuth with Prisma" |
| "Split schema into its own card" | "Generate Prisma migration from spec" |
| "QA web apps with Playwright smoke first" | "Run Playwright smoke suite" |

Rule: if a recipe describes *how to implement* something, it's a tool-in-disguise — migrate it to technician. Recipes only encode taste about sequencing and scope.

## What each agent owns

| Agent       | Owns                                          | Does NOT own                          |
|-------------|-----------------------------------------------|---------------------------------------|
| Planner     | Card breakdown, ordering, scope               | Code, tests, tool creation            |
| Builder     | Project code changes                          | Tool implementations, QA verdicts     |
| QA          | Verifying builder output against the card     | Code changes, scope decisions         |
| Gate        | Pass/retry/fail decision (rules-based)        | LLM reasoning                         |
| Technician  | Tool research, implementation, tests, registry | Project code, agent prompts          |
| Orchestrator | Run state, agent sequencing, ToolRequest plumbing | LLM reasoning of any kind         |

## Observability schema

Existing tables (`RunLog`, `AuditEntry`, `SecurityAlert`, `CardEvent`, `RunArtifact`) capture *what happened*. These five new tables capture *why*, *how much*, and *what left the box* — so any run can be reconstructed end-to-end.

| Table | Captures | Primary use |
|---|---|---|
| `LlmCall` | runId, agent, model, prompt, response, tokens, costUsd, durationMs, cacheHit | Cost attribution, prompt debugging |
| `ToolCall` | runId, agent, toolName, toolVersion, args, result, durationMs, ok | Tool reliability, dispatch debugging |
| `AgentDecision` | runId, agent, decisionType, reasoning, inputs, output | Postmortems, gate/retry analysis |
| `ExternalCall` | runId, target (gcp/github/technician), method, path, status, costUsd, durationMs | Egress audit, infra cost trail |
| `Approval` | runId, requestedAt, channel, payload, decidedBy, decision, decidedAt | Approval gate state, replay |

### Operational rules

- **Add incrementally.** Start with `LlmCall` and `ToolCall` — they cover ~80% of "what did the agent do".
- **Large payloads go to object storage.** Prompt/response > 8 KB writes to a GCS bucket; Postgres stores the pointer. Avoids row bloat.
- **Retention.** `LlmCall` and `ToolCall` purge after 30 days. `AgentDecision`, `Approval`, `ExternalCall` kept indefinitely (they're the audit trail). `Run` and `Card` never auto-purged.
- **Indexes.** All five tables index `(runId)` and `(createdAt)`. Cost queries also need `(createdAt, costUsd)` for time-range rollups.
- **`RunLog.metadata` discipline.** Define a TS discriminated union for log payloads so the board renders them without guessing.

## Migration notes

The existing prompts in [planner.ts](../pipeline/src/agents/planner.ts), [builder.ts](../pipeline/src/agents/builder.ts), and [qa.ts](../pipeline/src/agents/qa.ts) become `AGENTS.md` files. The existing [tool-registration.ts](../pipeline/src/agents/tool-registration.ts) and [tool-dispatch.ts](../pipeline/src/agents/tool-dispatch.ts) collapse into a thin technician client. Gate stays as-is (no LLM, no md).
