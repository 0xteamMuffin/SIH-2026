# SIH-26117 — System Handbook

The single reference for this project. What it is, how it is built, how to run it, how to verify it, and what is genuinely not done yet. Nine separate design docs used to live in this directory and had drifted out of sync with the code; this file replaces them (see [Appendix B](#appendix-b--what-happened-to-the-old-docs)).

Everything below was checked against the code at the time of writing. Where the code and an old doc disagreed, the code won.

---

## Contents

- [What this is](#what-this-is)
- [System at a glance](#system-at-a-glance)
- [Anatomy of a run](#anatomy-of-a-run)
- [Services](#services)
- [Clients](#clients)
- [Identity and authorization](#identity-and-authorization)
- [Document ingestion and understanding](#document-ingestion-and-understanding)
- [The agent runtime](#the-agent-runtime)
- [Tools](#tools)
- [Approval gate](#approval-gate)
- [Durable execution](#durable-execution)
- [Model registry and routing](#model-registry-and-routing)
- [Knowledge retrieval](#knowledge-retrieval)
- [Code sandbox](#code-sandbox)
- [Deliverables](#deliverables)
- [Artifact lifecycle](#artifact-lifecycle)
- [Sovereignty](#sovereignty)
- [API surface](#api-surface)
- [Observability](#observability)
- [Running it](#running-it)
- [Pointing it at your own Ollama](#pointing-it-at-your-own-ollama)
- [Verification](#verification)
- [Operations runbook](#operations-runbook)
- [Status — built vs not built](#status--built-vs-not-built)
- [Target state](#target-state)
- [Appendix A — earlier diagrams](#appendix-a--earlier-diagrams)
- [Appendix B — what happened to the old docs](#appendix-b--what-happened-to-the-old-docs)

---

## What this is

An on-premise AI workbench for confidential industrial knowledge work. You upload a document or state a task, an agent works on it — reading the document, looking at it, searching indexed internal material, running code — and hands back a real deliverable: a DOCX approval note, a PPTX deck, an XLSX workbook, source code. Every claim traces to evidence, anything risky waits for a human reviewer, and every step is written down.

Every piece of state lives in services the organization controls: PostgreSQL, MinIO, Qdrant, RabbitMQ. The model layer is a config file, so the same code path runs against a remote provider in development and a local open-weight model in a sovereign deployment.

The point of the project is not the model. Anyone can put a chat UI in front of an open-weight model in an afternoon. The work here is everything around it — durable execution that survives a crash mid-run, a human approval gate on consequential actions, evidence separated from model opinion, and a deployment that has no route out of the building.

---

## System at a glance

```mermaid
flowchart LR
  Operator([Operator]) --> IDE[Electron Workbench<br/>chat-first client]

  subgraph EDGE[Published surface]
    IDE
  end

  subgraph API[API process]
    direction TB
    Auth[Auth + RBAC<br/>JWT and refresh sessions]
    Routes[REST API<br/>OpenAPI 3.1]
    Outbox[(Transactional outbox)]
    Auth --> Routes
    Routes --> Outbox
  end

  IDE --> Auth

  Outbox --> Broker[[RabbitMQ<br/>durable queues + confirms]]

  subgraph WORKER[Worker process]
    direction TB
    Loop{{Agentic loop<br/>model picks next action}}
    Tools[Tool dispatch<br/>schema-validated]
    Loop --> Tools
    Tools --> Loop
  end

  Broker --> Loop

  subgraph HELPERS[Internal sidecars]
    direction TB
    Docling[Docling<br/>OCR, layout, tables]
    Renderer[PDF renderer<br/>bounded page rasterizer]
    Sandbox[Sandbox runner<br/>disposable containers]
  end

  Tools --> Docling
  Tools --> Renderer

  subgraph GATE[Human approval gate]
    Reviewer{{Reviewer or Admin}}
  end

  Tools -->|high-risk tool call| Reviewer
  Reviewer -->|approved, exact frozen input| Sandbox
  Sandbox -->|stdout / stderr / exit code| Loop
  Reviewer -->|rejected| Loop

  subgraph DATA[Controlled data layer]
    direction TB
    PG[(PostgreSQL<br/>system of record)]
    Obj[(MinIO<br/>files, extractions, deliverables)]
    Vec[(Qdrant<br/>rebuildable vector index)]
  end

  Routes --> PG
  Loop --> PG
  Tools --> Obj
  Tools -.-> Vec

  subgraph MODELS[Model layer — one config file]
    direction TB
    Router{Model router<br/>capability and priority}
    Local[Local runtime<br/>OpenAI-compatible]
    Remote[Remote providers<br/>development only]
  end

  Loop --> Router
  Router --> Local
  Router -.->|blocked in sovereign mode| Remote

  subgraph GOV[Governance]
    direction TB
    Audit[(Audit events)]
    Posture[Sovereignty posture<br/>+ egress ledger]
  end

  Routes -.-> Audit
  Loop -.-> Audit
  Reviewer -.-> Audit
  Router -.-> Posture

  classDef app fill:#DDF4FF,stroke:#1677B8,color:#0B3A58;
  classDef data fill:#FFF0C2,stroke:#BA7A00,color:#563800;
  classDef safe fill:#E0F7E9,stroke:#198754,color:#114D30;
  classDef dev fill:#FFE2E2,stroke:#C53030,color:#6E1515;
  classDef gate fill:#F3E8FF,stroke:#6B21A8,color:#3B0764;

  class IDE,Auth,Routes,Loop,Tools,Router,Docling,Renderer,Broker,Posture app;
  class PG,Obj,Vec,Outbox,Audit data;
  class Sandbox,Local safe;
  class Remote dev;
  class Reviewer gate;
```

Three structural decisions carry most of the weight:

1. **The API never executes work.** It writes the run row and an outbox event in one PostgreSQL transaction and returns. A dispatcher publishes the event; a worker picks it up. A run therefore survives an API restart between "accepted" and "started".
2. **The model decides the order of work.** There is no fixed pipeline. The agent is handed tools and calls them until it calls `final.answer`.
3. **Sovereignty is enforced in layers, not by a flag.** Network topology, environment validation, registry filtering, call-path guard, and data classification each block a remote call independently.

---

## Anatomy of a run

```mermaid
sequenceDiagram
  autonumber
  actor U as Operator
  participant A as API
  participant P as PostgreSQL
  participant Q as RabbitMQ
  participant W as Worker
  participant M as Model
  participant S as Sandbox
  actor R as Reviewer

  U->>A: Upload artifact
  A->>A: Validate signature, MIME, size
  A->>P: Persist metadata
  A->>Q: Extraction job
  Q->>W: Deliver
  W->>W: Extract text + provenance sidecar

  U->>A: POST /runs with task
  A->>P: AgentRun + outbox event, one transaction
  A-->>U: 202 accepted, budget snapshot
  A->>Q: Publish via confirm channel
  Q->>W: Deliver run

  loop until final.answer or budget exhausted
    W->>M: Transcript + tool definitions
    M-->>W: Tool call
    W->>P: Persist call with exact input
    alt low or medium risk
      W->>W: Execute, record evidence
    else high risk
      W->>P: WAITING_APPROVAL + immutable approval row
      W-->>Q: Release lease
      R->>A: Decision
      A->>P: Compare-and-set, resume event
      Q->>W: Redeliver
      W->>S: Exact frozen input, once
      S-->>W: stdout, stderr, exit code
    end
  end

  W->>P: Deliverable artifact + evidence links
  W->>P: COMPLETED
  U->>A: Download deliverable
```

---

## Services

| Service | Role | Host port |
|---|---|---|
| `backend` | Express API — auth, workspaces, artifacts, runs, approvals, knowledge, audit, sovereignty, admin/ops | `4000` |
| `worker` | Consumes agent and knowledge jobs from RabbitMQ and does the actual work | none |
| `frontend` | Next.js browser workbench | `3000` |
| `postgres` | System of record — users, workspaces, runs, tool calls, evidence, artifacts, audit, knowledge metadata | none |
| `minio` | Object storage — uploads, extracted text, provenance sidecars, generated deliverables | none |
| `qdrant` | Vector index for retrieval — rebuildable from PostgreSQL, not a source of truth | none |
| `rabbitmq` | Durable transport for agent and knowledge jobs | none |
| `docling` | CPU-only extraction — OCR, layout, tables for PDF/image/DOCX/PPTX/XLSX. Optional | none |
| `pdf-renderer` | Isolated sidecar that rasterizes bounded PDF pages to PNG for vision models | none |
| `sandbox-runner` | Spins up disposable, network-less containers for generated code | none |

Only `backend` and `frontend` publish a host port, and both sit on an `edge` bridge network for that reason. Everything else is reachable only on the `internal` network, which is declared `internal: true` — Docker attaches no gateway, so those containers have no route off the host. The sovereign override publishes nothing at all.

---

## Clients

**Next.js workbench** (`frontend/`) — browser client with login, workbench, artifacts, knowledge, audit, and admin views. It calls the API on relative paths by default, and `next.config.mjs` rewrites those to `BACKEND_INTERNAL_URL` (`http://backend:4000` in Compose), so the browser never needs direct access to the API network. Setting `NEXT_PUBLIC_API_URL` overrides that with an absolute base and makes the browser call the API directly — useful when running `next dev` on the host, not what the containerized stack does.

**Electron workbench** (`ide/`) — the desktop client, and the primary surface. It is deliberately not a code editor; it is chat-first, closer to an agent-mode IDE. Nothing is edited locally: code, documents, and datasets stay on the deployment, the agent changes them there, and the client renders what came back — prose, red/green diffs, document previews, spreadsheets, an embedded browser pane. It also carries the governance views: run trace, approvals, audit, admin, and a sovereignty view backed by the posture and egress APIs.

The Electron client runs on the host rather than inside the Compose network, which is why the API publishes `4000`.

---

## Identity and authorization

Users hold a global role — `ADMIN`, `OPERATOR`, or `REVIEWER` — plus per-workspace membership that can differ from it. Someone globally `OPERATOR` can hold `REVIEWER` membership on one workspace and approve things there and nowhere else. Approval authorization is resolved from the live `workspace_members` row inside the service, never from the JWT role claim.

Login issues a JWT plus a refresh session. Sessions are revocable, logout invalidates them, disabled users are rejected, and repeated failed logins are throttled and audited. Every upload, run, query, and approval is workspace-scoped and membership-checked before it executes.

OIDC/SSO is not wired in. The boundary leaves room for an adapter; there isn't one.

---

## Document ingestion and understanding

Two complementary paths. Neither is treated as universally authoritative.

**Deterministic extraction.**

1. The upload is validated on signature, extension, MIME type, UTF-8 where relevant, and a 25 MiB cap.
2. Bytes go to MinIO; PostgreSQL records metadata, an optional `previousArtifactId` for version lineage, and `retentionUntil`.
3. Extraction is by type — UTF-8 text, Markdown, and CSV are decoded locally with no external service; PDF, image, DOCX, PPTX, and XLSX go to the internal Docling service for OCR, layout, and table extraction.
4. Two objects are persisted: canonical extracted text/Markdown, and a separate versioned JSON **provenance sidecar** — page numbers, bounding boxes, table/picture/heading identity, character ranges — with its SHA-256 checksum recorded in PostgreSQL. The sidecar binds itself to both the source and canonical-text checksums. This is what lets a citation resolve to an exact page and region instead of "somewhere in the document".
5. Locally decoded text gets one-based line and zero-based half-open character provenance. Very high line counts are deterministically coalesced to the sidecar block limit.
6. Status (`PENDING` → `PROCESSING` → `COMPLETED`/`FAILED`) and timing are tracked per artifact.

Docling being down fails extraction for that artifact only. Worker startup and unrelated work do not depend on it, and readiness does not fail on it unless `DOCLING_REQUIRED=true`.

**Vision interpretation.** Vision-capable profiles get bounded PNG/JPEG/WEBP originals *alongside* the deterministic OCR text, never instead of it. For a vision-routed PDF the `pdf-renderer` sidecar rasterizes a deterministic selection — every page when the document has three or fewer, otherwise first, middle, and last. The sidecar is an isolated Node service using PDF.js and `@napi-rs/canvas`, with no egress, no capabilities, and a read-only root filesystem; each request runs in a terminable worker thread. Rendered pages and the base64 sent to a provider are never persisted or logged — only descriptors of what was sent.

Vision output is model analysis, not source evidence. A citation still has to resolve to a real page or region from the sidecar.

Limits worth knowing: representative page sampling can miss a relevant interior page (explicit page selection exists at the adapter boundary but is not exposed by the run API); encrypted, malformed, and over-long PDFs fail closed; TIFF extracts fine but vision inference on it fails explicitly rather than guessing at a conversion; and the per-page pixel cap can reduce effective DPI on unusually large pages.

---

## The agent runtime

The loop is model-driven. `backend/src/modules/agent/agent-loop.ts` hands the model the tool definitions and lets it choose what to do next, turn after turn, until it calls `final.answer`. Nothing in the code decides the order of work — the agent can read a document, notice a gap, search for it, and revise. There is no `SOURCE → ANALYZE → ACTION → FINALIZE` phase cursor; that was the earlier design and it is gone.

Two properties shape the implementation:

- **It survives suspension.** A high-risk tool can park a run for hours awaiting approval, so the loop holds no state in memory. The transcript is persisted message by message and rebuilt on every invocation, and a resumed run re-executes only tool calls whose result was never recorded.
- **It always terminates with something.** Exhausting a budget removes every tool except `final.answer` and forces it, so the user gets the best answer the evidence supports rather than a bare failure.

`final.answer` returns structured output — the answer as Markdown, a `confidence` of high/medium/low, and an optional list of things the evidence could not settle. Terminating through a tool rather than trailing off in prose means the loop never has to guess whether a reply was an answer or a step toward one.

**Budgets** are snapshotted per run at admission: max turns, max tool calls, cumulative input/output/total token budgets, and an absolute deadline. One turn is one model call, not one phase — reading a document, searching, producing a deliverable, and answering is already four. Budgets are cumulative across provider fallbacks and repair calls: before every call the worker sums persisted successful invocation usage and bounds the requested output by what remains. An exhausted budget stops the next call; an over-budget response is persisted and then terminally fails the run without queue retry. A provider that omits prompt or completion usage also fails the run closed.

**Conversation history** — a chat thread loads up to 8 prior turns (bounded per answer and in total) so a follow-up like "make it shorter" or "why?" has something to attach to. Runs are otherwise independent and carry no memory. Older context is dropped, not summarized.

Progress events are concise and deliberately never contain hidden reasoning or chain-of-thought.

**Evidence** is tagged `SOURCE` when it is grounded in an actual document or tool result, and `MODEL_OUTPUT` when the model produced it. The two are kept as separate lists on the run so a deliverable's claims can be checked against what is actually backed by something.

---

## Tools

| Tool | Risk | Approval | What it does |
|---|---|---|---|
| `artifact.read` | LOW | no | Read an artifact's extracted text by id |
| `artifact.inspectVisually` | LOW | no | Look at the document as an image — for scans, photographs, stamped forms, drawings |
| `knowledge.search` | LOW | no | Search indexed internal material; returns up to eight cited passages |
| `deliverable.createApprovalNote` | MEDIUM | no | Generate a DOCX approval note |
| `deliverable.createPresentation` | MEDIUM | no | Generate a PPTX deck |
| `deliverable.createSpreadsheet` | MEDIUM | no | Generate an XLSX workbook with real formulas |
| `code.persistOutput` | LOW | no | Save generated code as a downloadable file. Does not run it |
| `final.answer` | LOW | no | Finish the run and return the answer |
| `sandbox.execute` | HIGH | **yes** | Run a short Python or JavaScript program in an isolated sandbox |

Every tool call is schema-validated against the same schema the model was shown, and persisted with its exact input before it runs. Tool descriptions live beside their schemas rather than in a separate table, because the description is what the model actually reads when choosing between tools — and smaller local models need that to route correctly.

For the deliverable tools, the model supplies the document body but **not** the citations. Those are resolved server-side from the evidence records referenced by `evidenceIds`, so a fabricated source cannot reach a generated document.

Tool-calling *quality* varies far more than tool-calling *availability*. Smaller local models will often accept the tools parameter and then emit malformed arguments or ignore the tools entirely, so a bad call is treated as a recoverable turn, not a run failure.

---

## Approval gate

`sandbox.execute` is the one high-risk tool today, and policy requires reviewer approval for every high-risk call.

The worker atomically writes a `WAITING_APPROVAL` tool call plus an approval row holding the exact validated `{ language, code }` input, moves the run to `WAITING_APPROVAL`, and releases its lease. A database trigger makes the approval's run, workspace, tool, risk, and input immutable — the code a reviewer sees is the code that runs.

A workspace `REVIEWER` or `ADMIN` decides via `POST /api/agent-approvals/:approvalId/decision` with `{ "decision": "APPROVED" | "REJECTED", "note"?: "..." }`. The decision uses a pending-status compare-and-set, transitions the run to `PENDING`, and writes `agent.run.resumed` to the outbox in the same transaction. On resume, an approval executes the frozen input exactly once; a rejection comes back to the model as a denied tool result and no code executes.

---

## Durable execution

PostgreSQL is the source of truth; RabbitMQ is only the transport. Broker availability must never determine whether an accepted run is preserved.

- The API creates the `AgentRun` and its outbox event in one transaction. A dispatcher publishes unpublished events through a confirm channel.
- The worker consumes persistent messages with manual acknowledgements and bounded prefetch, acknowledging only after a terminal database transition or a confirmed retry/dead-letter publication.
- Admission is serialized by a transaction-scoped advisory lock: one queued or active run per workspace (`409`), and `AGENT_MAX_CONCURRENT_RUNS_PER_USER` per requester across workspaces (`429`).
- The worker claims at most `QUEUE_PREFETCH` `RUNNING` rows globally, across replicas, under a separate advisory lock. A capacity miss leaves the run pending and writes a delayed outbox request rather than consuming a retry.
- Active claims carry a lease id, heartbeat, and expiry. Startup and periodic recovery atomically return expired `RUNNING` claims to `PENDING` with a fresh outbox event. Lease ids fence completed and retried transitions from an obsolete worker attempt.
- Redelivery is expected and made safe by compare-and-set transitions, tool idempotency keys, and deterministic object keys for generated artifacts. Completed tool outputs are replayed rather than re-executed.
- Invalid payloads are dead-lettered without execution.
- Graceful shutdown stops new deliveries and gives active jobs a bounded window before unacknowledged deliveries return to the broker.

Knowledge jobs use the same outbox guarantees on an isolated exchange, queues, channel, prefetch, and retry policy. The worker provisions the active knowledge index before starting either consumer and drains both on shutdown.

### Topology

| Resource | Purpose |
|---|---|
| `workbench.agent` | Durable direct exchange for agent jobs |
| `workbench.agent.runs` | Durable primary queue consumed by agent workers |
| `workbench.agent.retry` | Durable retry queue returning messages after a bounded delay |
| `workbench.agent.dead` | Dead-letter queue for exhausted or invalid messages |
| `workbench.agent.control` | Durable fanout exchange for cancellation, delivered to every live worker |
| `workbench.knowledge` | Durable direct exchange for knowledge jobs and retry/dead-letter routing |
| `workbench.knowledge.jobs` | Durable primary queue consumed by knowledge workers |
| `workbench.knowledge.retry` | Durable retry queue for knowledge jobs |
| `workbench.knowledge.dead` | Dead-letter queue for knowledge jobs |

Message bodies carry identifiers only. Documents, extracted text, prompts, and secrets are never in a queue message — the worker loads them from authorized durable storage.

### Cancellation

The `CANCELLED` transition and its outbox event commit in one transaction, cancelling pending approvals and unfinished tool calls alongside. Pending, running, and `WAITING_APPROVAL` runs can all be cancelled; repeating the request returns the existing cancelled run without a second event. The dispatcher broadcasts the command to every live worker, and the worker owning the delivery aborts its per-run controller, which propagates into in-flight model and sandbox HTTP requests. Heartbeat lease loss is the fallback when a control message is missed.

Control queues are exclusive and worker-local, so a broadcast sent while no worker is connected is not retained. PostgreSQL stays authoritative: a later delivery cannot claim a cancelled run.

---

## Model registry and routing

`backend/config/models.json` is the whole story — two lists, `providers` and `models`. No vendor name appears in application logic or in an environment-variable name.

A **provider** has an id, a `local` or `remote` location, an OpenAI-compatible base URL (`baseUrl`, or `baseUrlEnv` to take it from the environment), and optionally `apiKeyEnv`. A **model profile** references a provider, declares capabilities (`general`, `document`, `vision`, `code`, `embedding`, `reranking`), a priority, an enabled state, an output-token limit, and optional versioned pricing.

**Lower priority number wins.** Every other profile with a matching capability becomes an ordered fallback. Only input modality is a hard filter; task specializations are quality preferences expressed through priority.

The registry as configured today:

| Provider | Location | Profiles | Priority band |
|---|---|---|---|
| `development-remote` (OpenRouter) | remote | general, reasoning, code, vision, text + multimodal embedding, free fallback | 10–900 |
| `groq` | remote | general, code | 200 |
| `gemini` | remote | general/vision/code | 300 |
| `mistral` | remote | general/code | 400 |
| `cloudflare` | remote | general, vision, embedding | 500 |
| `local-runtime` (Ollama-shaped) | local | general, vision, code, text embedding | 1000 |

So in a development stack with keys present, remote profiles are tried first and the local runtime is the last resort. Setting `ALLOW_REMOTE_INFERENCE=false` filters every remote profile out of the registry before the router sees it, which is what makes the local runtime the only candidate.

`supportsTools` declares whether a profile may be given tool definitions. It **defaults to `false`**, so a profile is only offered tools once someone has confirmed the provider handles them; asking a profile without the flag for tools fails with `MODEL_TOOLS_UNSUPPORTED` before any request is sent. Both error directions are costly — a false positive fails at runtime with a confusing message, a false negative silently downgrades a capable model — so `node ops/verify-model-tools.mjs [profileId ...]` probes each configured profile with a trivial tool and exits non-zero where the registry disagrees with reality. Rate limits and 5xx are reported as inconclusive, never as a refusal. The probe needs credentials and network, so it is a development check and is not part of the sovereign suite.

**Embedding profiles** must also declare an immutable `revision`, exact `dimensions`, a `distance` function, `maxBatchInputs`, `maxBatchCharacters`, `maxInputCharacters`, and `inputModalities`. Text-embedding selection considers only enabled `TEXT` profiles, applies the classification policy, and picks exactly one by ascending priority then id. An index is permanently bound to that profile's revision, dimensions, and distance — there is no fallback to another embedding profile for reads or writes in an existing index, even one with identical dimensions, because that would silently mix vector spaces. A profile failure fails the operation. Changing embedding models means a new index and re-embedding.

**Reranking profiles** would need `revision`, `maxDocuments`, `maxDocumentCharacters`, `maxBatchCharacters`, and `maxQueryCharacters`, and use an OpenAI-compatible-style `POST /rerank` requiring a complete unique permutation. None is configured today, so retrieval preserves vector-similarity order and makes no provider call.

**Pricing and telemetry.** Optional `pricing` records `version`, `currency`, and per-million input/output rates. Every invocation attempt persists provider, profile, model, status, latency, token usage, finish reason, sanitized failure, and — when pricing exists — an estimated integer micro-USD cost with the pricing version used. Profiles without pricing keep a null estimate; the backend does not invent rates.

**Probes.** `GET /api/admin/model-providers/status` (global admin) sends a content-free `GET /models` to each configured, policy-enabled provider and compares returned ids with enabled profiles. Disabled providers and those missing an endpoint or credential are reported without any network access. Responses never include credentials, environment-variable names, upstream bodies, prompts, or document content.

Adding a provider is five config lines and a restart: unique id, OpenAI-compatible `baseUrl`, `local` or `remote`, optional `apiKeyEnv`, then one or more profiles with capabilities and deterministic priorities. Secrets never go in `models.json`.

### Model environment variables

| Variable | Purpose |
|---|---|
| `MODEL_CONFIG_PATH` | Registry path. `config/models.json` outside Docker, `/app/config/models.json` inside |
| `ALLOW_REMOTE_INFERENCE` | Enables `remote` profiles. Must be `false` in sovereign mode |
| `MODEL_REQUEST_TIMEOUT_MS` | Maximum duration of one model request |
| `AGENT_MAX_TURNS`, `AGENT_MAX_TOOL_CALLS` | Per-run loop bounds |
| `AGENT_MAX_INPUT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_TOTAL_TOKENS` | Cumulative per-run token budgets |
| `AGENT_RUN_DEADLINE_MS`, `AGENT_MAX_CONCURRENT_RUNS_PER_USER` | Absolute deadline and per-user concurrency |
| `VISION_MAX_IMAGE_BYTES` | Combined image payload ceiling for one vision request. 10 MiB default, cannot exceed the 25 MiB upload limit |
| `PDF_RENDERER_URL`, `PDF_RENDERER_API_TOKEN` | Internal renderer endpoint and shared credential |
| `PDF_RENDER_TIMEOUT_MS` | End-to-end render deadline; cancellation also terminates the sidecar worker thread |
| `PDF_RENDER_MAX_SOURCE_BYTES`, `PDF_RENDER_MAX_PAGES`, `PDF_RENDER_DPI` | Adapter and sidecar input bounds |
| `PDF_RENDER_MAX_DOCUMENT_PAGES` | Sidecar-only ceiling on the source document's page count |
| `PDF_RENDER_MAX_PIXELS_PER_PAGE`, `PDF_RENDER_MAX_TOTAL_BYTES` | Per-page pixel ceiling and combined PNG response ceiling |
| `PDF_RENDERER_CONCURRENCY` | Sidecar-only concurrent render limit; excess fails fast for queue retry |

Provider credentials are `REMOTE_MODEL_API_KEY` (OpenRouter), `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, and `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_AI_BASE_URL` in the form `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1`. Populate only what you intend to use; a provider whose key is absent is filtered out of the registry rather than failing at call time. Restart the worker after adding or rotating a key. Keys belong only in the git-ignored root `.env` — never in `models.json`, an issue, a log, or a slide.

---

## Knowledge retrieval

Extracted content is chunked with its provenance locations preserved, embedded with the one selected text-embedding profile, and indexed into Qdrant as either `WORKSPACE_PRIVATE` or `ORGANIZATION_SHARED`. Indexing and querying both run as durable jobs through the worker, never inline in the API. Every query is filtered by workspace access, source lifecycle, index revision, and classification before results return, so nothing crosses a workspace boundary.

Qdrant is a rebuildable cache, not a system of record. PostgreSQL tracks source and index state well enough that `POST /api/admin/knowledge-indexes/rebuild` (global admin) can regenerate it from scratch. Deleting a knowledge source marks it non-retrievable immediately and returns `202`; durable `REMOVE_SOURCE` jobs — one per linked collection — then delete its points, and an active indexing lease is allowed to fence itself out first so a late upsert cannot recreate points after deletion. A periodic reconciliation job (`KNOWLEDGE_RECONCILIATION_INTERVAL_MS`) repairs missing or stale index rows, validates ready rows against Qdrant point counts and revision payloads, resumes interrupted removals, and deletes only orphan points whose source is absent or terminally inactive in PostgreSQL.

Model-version migration is not automatic, because a safe cutover needs a fully backfilled replacement index before activation.

---

## Code sandbox

Approved `sandbox.execute` calls go to the `sandbox-runner` service over the internal network. It spins up one disposable container per job — curated Python or Node image, non-root, read-only root filesystem, no network, dropped Linux capabilities, CPU/memory/PID/time limits — captures stdout, stderr, and exit code with bounded output, and tears the container down. Runner jobs are authenticated and asynchronous with idempotent cancellation, and stale containers are cleaned up.

Execution images are preloaded and pinned, then run with `--pull never`, so nothing gets fetched mid-demo and the sandbox works air-gapped:

```text
node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d
```

The API process never executes code. Windows development is explicitly lower-assurance; isolated Linux is the production target.

Not done: complete sandbox execution audit events, and production runner attestation.

---

## Deliverables

Three generated formats today — DOCX approval notes, PPTX decks, and XLSX workbooks with real formulas, units, and assumptions rather than static values — plus persisted source code via `code.persistOutput`.

Each is generated from persisted evidence, versioned as an artifact, linked back to its source run, and structurally validated as an Office package before it is exposed for download. Generated artifacts inherit the data classification of the run that produced them, so a confidential source cannot yield a deliverable that reads as public.

---

## Artifact lifecycle

Artifacts move `ACTIVE → DELETING → DELETED`. Deletion requires workspace `ADMIN`, returns `202`, and exposes the durable deletion job's state. It is rejected while retention applies, while a non-terminal run references the artifact, while extraction is running, or while the artifact has an active knowledge source or indexing job. Cleanup of MinIO objects and vectors for inactive knowledge sources runs asynchronously and is retry-safe; metadata stays queryable for audit afterwards. Repeating a delete request is safe — it requeues whatever exhausted its prior attempts. Expired deletion claims are reconciled.

---

## Sovereignty

Two words used precisely.

**Sovereign** means the organization controls the data stores, the model endpoint, access control, and the logs. **Air-gapped** is the stronger claim: no route to the public internet at all, enforced by network policy rather than application logic.

A remote inference call requires *all* of the following. Any one failing blocks the call before content is transmitted:

1. `ALLOW_REMOTE_INFERENCE=true`.
2. The selected profile's provider is marked `remote`.
3. The variable named by `apiKeyEnv` holds a credential.
4. The task and source data are classified `PUBLIC` or `SYNTHETIC`.
5. The backend has an egress-capable network attachment.

`INTERNAL` and `CONFIDENTIAL` data can never reach a remote provider regardless of the flag — that check is independent of the sovereign/development toggle.

The five controls the sovereignty module reports on, and where each is enforced:

| Control | Mechanism | Where |
|---|---|---|
| Network isolation | Sovereign profile drops the egress network; the remainder is `internal: true`, so Docker attaches no gateway | `docker-compose.sovereign.yml` |
| Process guard | Environment validation rejects `APP_MODE=sovereign` with `ALLOW_REMOTE_INFERENCE=true` — the process fails to boot rather than being talked into remote inference | `backend/src/config/env.ts` |
| Registry filter | Remote profiles are removed before the router sees them, so a remote model cannot be selected even by explicit request | `model-registry.ts` |
| Call-path guard | Policy is checked before the request is constructed, so a blocked call never reaches the network stack | `model-provider.ts`, `embedding-provider.ts` |
| Classification policy | `INTERNAL`/`CONFIDENTIAL` are refused an external route in every mode | `lib/data-classification.ts` |

Two of these are *structural* — true in every mode, not toggled. Two are *enforced* only in sovereign mode and report as *development* otherwise. The API says which is which rather than claiming a blanket posture.

### Sovereignty API

| Endpoint | Access | What it returns |
|---|---|---|
| `GET /api/sovereignty/posture` | authenticated | Mode, remote-inference flag, the five controls with per-control state, every provider with host/credential-presence/policy-selectability, per-capability local vs remote profile coverage and whether that capability is sovereign-ready, and the classifications denied a remote route |
| `GET /api/sovereignty/egress` | global admin | Ledger of recorded provider invocations grouped by local/remote/unknown channel, with per-provider counts |
| `POST /api/sovereignty/egress-probe` | global admin | Actively attempts to reach each configured provider host and reports `blocked` or `reachable` with a transport reason |

The posture view deliberately mirrors the registry's own filter, so it cannot claim a profile is selectable when the router would skip it. The egress probe is the honest one: it demonstrates the absence of a route rather than asserting it.

Sovereign mode removes the application's own path out. It is not a substitute for the organization's firewall — that caveat is real and worth stating out loud rather than glossing.

---

## API surface

OpenAPI 3.1 is served live at `GET /openapi.json`, with the contract version tracked in `info.version` independently of the app version. There is no bundled documentation UI; the JSON is the source for tooling. Validate the contract and its coverage of registered Express routes with `cd backend && npm run test:openapi`.

Protected operations use the bearer token from `POST /api/auth/login`:

```text
Authorization: Bearer <token>
```

| Mount | Covers |
|---|---|
| `/api/auth` | Login, refresh, logout, session revocation |
| `/api/workspaces` | Workspaces, membership, roles, per-workspace runs and artifacts |
| `/api` (artifacts) | Upload, list, metadata, versioned lineage, deletion |
| `/api` (agent) | Run creation, reads, cancellation, `/api/agent-approvals/:id/decision` |
| `/api` (knowledge) | Knowledge sources, queries, deletion |
| `/api` (audit) | Workspace audit listing and JSON/NDJSON export |
| `/api/sovereignty` | Posture, egress ledger, egress probe |
| `/api/admin/...` | User administration, model-provider status, knowledge-index rebuild |

`GET /health` is unauthenticated process liveness with no dependency I/O. `GET /ready`, `GET /metrics`, and `GET /api/admin/model-providers/status` require a global administrator because they expose operational detail.

Audit listing requires workspace access; export requires workspace `ADMIN`. Audit responses contain only record ids, event type, timestamps, and the already-sanitized metadata persisted with the event — no secrets, no raw payloads.

Run creation returns `409 WORKSPACE_RUN_CONCURRENCY_LIMIT_EXCEEDED` or `429 USER_RUN_CONCURRENCY_LIMIT_EXCEEDED` as described under [durable execution](#durable-execution), and exposes its immutable token-budget snapshot in `state.tokenBudget`.

---

## Observability

`GET /ready` probes PostgreSQL, MinIO, RabbitMQ, Qdrant, the sandbox runner, and Docling concurrently, each bounded by `READINESS_TIMEOUT_MS`. Docling reports `optional_unavailable` without failing readiness unless `DOCLING_REQUIRED=true`.

`GET /metrics` returns Prometheus text exposition. Request labels are method, registered route template, and status code only. Run, knowledge-job, and model-invocation gauges use bounded enum labels. No workspace, user, prompt, or payload value ever becomes a label — that is a cardinality decision and a confidentiality one at the same time.

Logging is structured with request ids and redaction. Progress events are concise by design and never carry model reasoning.

---

## Running it

**Development stack.** Both clients' ports are published.

```bash
cp .env.example .env      # then change every development secret
docker compose up -d --build
```

The API is on `http://localhost:4000` (`/health` for a quick check), the browser workbench on `http://localhost:3000`. Sign in with the seeded admin credentials from `.env`.

`ALLOW_REMOTE_INFERENCE` may be `true` here — set it only if you accept that anything classified `PUBLIC`/`SYNTHETIC` may go to OpenRouter/Groq/Gemini/Mistral/Cloudflare. Anything else still will not leave, flag or no flag.

**Sovereign stack.** Publishes nothing, keeps `backend` and `worker` on the closed internal network, sets `ALLOW_REMOTE_INFERENCE=false`, and strips every remote credential.

```bash
docker compose -f docker-compose.yml -f docker-compose.sovereign.yml up -d --build
```

This needs a reachable local model endpoint — the registry defaults assume something Ollama-shaped at `host.docker.internal:11434`. No image is auto-pulled for it; you bring your own runtime.

**Hot reload.** Bind-mounts source and runs `tsx watch` / `next dev` instead of built output:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build backend worker frontend
```

`node_modules` for each service stays in a named volume so host and container installs do not collide. Data services are unaffected and can keep running from the base file. Not for sovereign or production use — dev images keep devDependencies and run as root.

One trap: the dev override builds `backend` and `worker` from `Dockerfile.dev` under the **same image tags** as the base file. Those dev images run `dist/*.js`-less watch mode and expect the bind mount, so after using the override you must rebuild to come back:

```bash
docker compose up -d --build      # the --build matters
```

**Electron client.**

```bash
cd ide
npm install
npm run dev
```

It has no offline mode — every answer comes from the backend, so it opens on sign-in. In development the form arrives prefilled from the repository `.env` (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`); override with `WORKBENCH_EMAIL`, `WORKBENCH_PASSWORD`, `WORKBENCH_BACKEND_URL`. A packaged build never receives these. Credentials go straight to the main process and are never persisted, so a restart requires signing in again.

**Config notes.** `backend/Dockerfile` bakes `config/` into the image, so editing `models.json` requires `docker compose up -d --build backend worker` to take effect. Compose supplies `local-development-qdrant-key-change-me` only when an older local `.env` has no `QDRANT_API_KEY`; replace it with a long random value before any shared deployment. `ops/rotate-local-secrets.mjs` will regenerate local secrets.

---

## Pointing it at your own Ollama

Common case: Ollama runs on a different machine on the LAN.

**On the machine running Ollama** — it binds `127.0.0.1` by default, so it must be told to listen on the network:

```bash
sudo systemctl edit ollama     # [Service]  Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
```

Open port `11434` in its firewall, then confirm from the workbench host *before* changing any config:

```bash
curl http://<OLLAMA_HOST_IP>:11434/v1/models
```

**On the workbench host:**

1. Point `local-runtime` at it — change its `baseUrl` in `backend/config/models.json` to `http://<OLLAMA_HOST_IP>:11434/v1`.
2. Match the model ids. The registry references `qwen3.5:4b` (general, vision), `qwen2.5-coder:7b` (code), and `nomic-embed-text` (embedding). Retag any profile whose model you have not pulled.
3. Set `ALLOW_REMOTE_INFERENCE=false` in `.env`. Local profiles are priority `1000` and sorting is ascending, so with remote keys present nothing would ever reach Ollama.
4. Rebuild, because `config/` is baked into the image: `docker compose up -d --build backend worker`.

**Model requirements.** The agent loop always offers tools, and the router hard-filters on `supportsTools`, so a model without tool calling cannot run a turn — it will either be skipped entirely or accepted and then rejected by the provider. Gemma 3 has no tool support in Ollama and so cannot drive an agent run; it can still exercise plain completion and vision paths. `qwen3:4b` or similar is the small tool-capable option. Knowledge indexing additionally needs `nomic-embed-text` (or another embedding model, retagged). Note that the embedding profile declares 768 dimensions and cosine distance — swapping in a different-dimension model requires a new Qdrant index, not just a config edit.

---

## Verification

The harness uses synthetic fixtures and needs no external API or provider credential.

**Deterministic checks**, from the repository root:

```bash
node ops/verify-sovereign-compose.mjs
cd backend
npm run test:security
npm run typecheck
npm run test
```

The Compose verifier renders both Compose files before checking them. It fails if `backend` or `worker` has a non-internal network or a host gateway, if remote-provider credential variables survive rendering, or if an internal service publishes a host port.

Migrations, against a fresh disposable database whose target schema must be empty:

```bash
MIGRATION_TEST_DATABASE_URL=postgresql://test:test@localhost:5432/sih_migration_test npm run test:migrations
```

It refuses a populated schema, deploys all migrations, runs Prisma's status check, and compares the migration ledger against the migration directories.

**Black-box acceptance.** `ops/backend-acceptance.mjs` exercises health, local authentication, workspace isolation, text and image uploads, upload-mismatch rejection, run creation and terminal cancellation, approval non-disclosure, the knowledge-source and query APIs, RabbitMQ delivery, and the authenticated sandbox API. It expects an already-running disposable stack:

```bash
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.sovereign.yml -f ops/docker-compose.acceptance.yml up --build --wait postgres minio minio-init qdrant rabbitmq sandbox-runner backend worker
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.sovereign.yml -f ops/docker-compose.acceptance.yml run --build --rm acceptance
```

The runner joins only the internal network and adds no egress. The overlay is test-only because it mounts the test script and fixtures. Tear down with the same file arguments and `down --volumes`. Overrides: `ACCEPTANCE_API_URL`, `ACCEPTANCE_AMQP_URL`, `ACCEPTANCE_SANDBOX_URL`, `ACCEPTANCE_SANDBOX_TOKEN`, `ACCEPTANCE_ADMIN_EMAIL`, `ACCEPTANCE_ADMIN_PASSWORD`.

**Other verifiers in `ops/`:** `verify-agent-loop.mjs`, `verify-conversation-followup.mjs`, `verify-deliverable-authoring.mjs`, `verify-model-tools.mjs`, `verify-empty-migrations.mjs`, `qdrant-snapshot.mjs`, `rotate-local-secrets.mjs`.

**Optional live provider.** `ACCEPTANCE_LIVE_PROVIDER=true` only in a development stack with a configured remote provider. It submits a `PUBLIC` synthetic prompt and requires the run to complete. Deliberately excluded from CI and never to be pointed at restricted data.

---

## Operations runbook

Run recovery exercises on an isolated host and a fresh Compose project. Never test a restore over the only copy of production data.

### Version and image policy

Service images and Dockerfile bases are pinned to release tags *and* registry digests. Update tag and digest together after testing; never copy a digest from an unrelated tag or architecture. `docker compose pull` and `build --pull` belong only on the connected staging host used to prepare a release.

### Backup boundary

A recoverable set needs PostgreSQL, MinIO objects, Qdrant snapshots, RabbitMQ definitions, the deployed Compose files, `.env` or its secret-manager export, and model configuration. Store secrets separately from data, encrypt both at rest, and restrict the RabbitMQ export — it contains credential hashes.

The commands are intentionally manual. Set a destination outside the repository:

```bash
umask 077
export BACKUP=/secure-backups/sih-2026/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP"/{minio,qdrant}
```

Quiesce writers first:

```bash
docker compose stop frontend backend worker sandbox-runner
docker compose exec -T rabbitmq rabbitmqctl list_queues --formatter json name messages_ready messages_unacknowledged
```

Wait for `messages_unacknowledged` to reach zero, and decide whether queued jobs must finish, be cancelled, or be reconstructed from PostgreSQL. Keep the four data services running for the logical backups, and prevent external API and AMQP clients from writing for the whole window.

**PostgreSQL** — transactionally consistent logical dump, no destructive flags:

```bash
docker compose exec -T postgres sh -ec \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  > "$BACKUP/postgres.dump"
test -s "$BACKUP/postgres.dump"
```

**MinIO** — one bucket, no object versioning. `minio-init` recreates the private bucket policy.

```bash
docker compose run --rm --no-deps \
  --volume "$BACKUP/minio:/backup" \
  --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc mirror --overwrite --preserve "local/$MINIO_BUCKET" "/backup/$MINIO_BUCKET"
  '
```

If versioning or retention is enabled later, replace this with a tested version-aware procedure.

**Qdrant** — one consistent snapshot per collection, downloaded and checksummed; only the temporary server-side snapshot is deleted. The helper refuses a directory that already has a manifest and never deletes collections or points.

```bash
docker compose run --rm --no-deps --user 0:0 \
  --volume "$PWD/ops:/ops:ro" \
  --volume "$BACKUP/qdrant:/backup" \
  backend node /ops/qdrant-snapshot.mjs backup /backup
test -s "$BACKUP/qdrant/manifest.json"
```

**RabbitMQ** — topology, policies, vhosts, users, permissions:

```bash
docker compose exec -T rabbitmq rabbitmqctl export_definitions /tmp/definitions.json
docker compose cp rabbitmq:/tmp/definitions.json "$BACKUP/rabbitmq-definitions.json"
docker compose exec -T rabbitmq rm -f /tmp/definitions.json
test -s "$BACKUP/rabbitmq-definitions.json"
```

Definitions do not contain queued messages. Drain the queues first, or document which durable jobs will be reconciled from PostgreSQL after recovery. A raw volume copy is not a portable backup unless node names, Erlang cookies, image versions, and shutdown consistency are all controlled and tested.

**Seal and resume** — copy the exact deployment inputs, then checksum everything. Do not include `SHA256SUMS` in its own input list.

```bash
cp docker-compose.yml docker-compose.sovereign.yml "$BACKUP/"
cp -R backend/config "$BACKUP/backend-config"
(cd "$BACKUP" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
(cd "$BACKUP" && sha256sum -c SHA256SUMS)
docker compose start rabbitmq qdrant minio postgres sandbox-runner worker backend frontend
```

Store `.env` or its secret-manager export separately under the same recovery identifier — no plaintext secrets in the data backup. Record the backup path, deployment revision, start/end time, queue state, file count, checksum result, and operator identity, then copy the sealed set to separate failure domains per the retention policy.

### Restore into an empty target

Isolated network, distinct Compose project, and only after `sha256sum -c SHA256SUMS` succeeds. These assume the separately protected environment configuration has been reviewed and installed as the target `.env`.

```bash
docker compose up -d postgres minio qdrant rabbitmq
docker compose ps
```

**PostgreSQL** — confirm no application tables; the restore has no `--clean` or drop option and fails on conflict:

```bash
docker compose exec -T postgres sh -ec \
  'test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from information_schema.tables where table_schema = '\''public'\''")" = 0'
cat "$BACKUP/postgres.dump" | docker compose exec -T postgres sh -ec \
  'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --single-transaction --no-owner --no-acl'
```

**MinIO** — create the bucket, verify it is empty, then mirror:

```bash
docker compose run --rm --no-deps minio-init
docker compose run --rm --no-deps \
  --volume "$BACKUP/minio:/backup:ro" \
  --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    test -z "$(mc ls --recursive "local/$MINIO_BUCKET")"
    mc mirror --overwrite --preserve "/backup/$MINIO_BUCKET" "local/$MINIO_BUCKET"
  '
```

**Qdrant** — verifies every snapshot, refuses a target containing any collection, and requires explicit confirmation. If a restore fails after creating a collection, discard that target and retry with another empty one.

```bash
docker compose run --rm --no-deps --user 0:0 \
  --environment RESTORE_CONFIRM=empty-qdrant-target \
  --volume "$PWD/ops:/ops:ro" \
  --volume "$BACKUP/qdrant:/backup:ro" \
  backend node /ops/qdrant-snapshot.mjs restore /backup
```

**RabbitMQ** — import into the fresh broker before workers connect:

```bash
docker compose cp "$BACKUP/rabbitmq-definitions.json" rabbitmq:/tmp/definitions.json
docker compose exec -T rabbitmq rabbitmqctl import_definitions /tmp/definitions.json
docker compose exec -T rabbitmq rm -f /tmp/definitions.json
```

**Validate** — apply newer migrations, start the app, check health before enabling ingress:

```bash
docker compose run --rm --no-deps backend npx --no-install prisma migrate deploy
docker compose up -d sandbox-runner worker backend frontend
docker compose ps
docker compose exec -T postgres sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from \"_prisma_migrations\""'
docker compose exec -T rabbitmq rabbitmq-diagnostics -q ping
```

Then verify representative object downloads, Qdrant collection and point counts, authentication, one read-only API path, and one synthetic end-to-end job. Keep the original environment unavailable for writes until the recovery owner approves cutover.

### Offline image bundle

Prepare on a connected Linux host of the same target architecture. Build first so Compose-generated image names exist:

```bash
docker compose --env-file .env build --pull
mapfile -t images < <(docker compose --env-file .env config --images | sort -u)
images+=(
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
  "python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d"
)
docker image inspect "${images[@]}" >/dev/null
docker image save --output sih-2026-images.tar "${images[@]}"
sha256sum sih-2026-images.tar > sih-2026-images.tar.sha256
sha256sum docker-compose.yml docker-compose.sovereign.yml .env.example \
  backend/package-lock.json backend/sandbox-runner/package-lock.json frontend/package-lock.json \
  > sih-2026-deployment.sha256
```

Transfer the tar, both checksum files, the deployment files, the application source the Compose build metadata needs, and the protected production configuration through the approved media process. On the offline target:

```bash
sha256sum -c sih-2026-images.tar.sha256
sha256sum -c sih-2026-deployment.sha256
docker image load --input sih-2026-images.tar
docker compose --env-file .env config --images | while IFS= read -r image; do docker image inspect "$image" >/dev/null; done
docker image inspect \
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32" \
  "python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d" >/dev/null
docker compose --env-file .env -f docker-compose.yml -f docker-compose.sovereign.yml config --quiet
docker compose --env-file .env -f docker-compose.yml -f docker-compose.sovereign.yml up -d --no-build --pull never
```

Keep the source tar immutable. Generate a new signed release artifact rather than modifying a bundle in place.

---

## Status — built vs not built

Being explicit, because it is easy to over-claim from a document like this.

**Working today**

- Global roles plus per-workspace membership, refresh sessions with revocation, login throttling, failed-auth auditing.
- Durable runs: transactional outbox, publisher confirms, manual acks, leases with heartbeats, stale-claim recovery, real cancellation propagated into in-flight model and sandbox requests, workspace/user/global concurrency limits.
- A model-driven agentic loop with nine registered tools, schema-validated inputs, idempotency keys, per-run turn/tool/token/deadline budgets, and forced termination through `final.answer`.
- Human approval gating on high-risk tools, with the reviewed input frozen immutable by a database trigger and executed exactly once on resume.
- Ingestion for PDF, image, DOCX, PPTX, XLSX, CSV, Markdown, and text, with OCR and bounded page/table/heading/bbox/character provenance.
- Vision on scanned pages through an isolated bounded PDF rasterizer, with image payloads kept out of logs, messages, and telemetry.
- Knowledge chunking, indexing, access-filtered retrieval, deterministic citation assembly, source deletion, explicit index rebuild, and periodic reconciliation.
- Approval-gated sandbox execution in disposable, network-less, non-root, resource-capped containers with preloaded pinned images.
- DOCX, PPTX, and XLSX generation from persisted evidence, structurally validated, classification-inheriting, version-linked.
- Vendor-neutral model registry with priority fallbacks, per-invocation telemetry, versioned cost estimation, content-free provider probes, and a tool-support verifier.
- Sovereignty posture, egress ledger, and active egress probe, surfaced in the desktop client.
- OpenAPI 3.1 contract with a coverage test, admin-only readiness and metrics, workspace audit search and export.
- Backup, restore, and offline-bundle procedures; CI gates for tests, types, build, migrations, OpenAPI, and containers.

**Not done**

- No local CPU embedding model with pinned model files. A local embedding profile exists in the registry, but it assumes an external Ollama-shaped runtime rather than a bundled offline model.
- No reranking profile configured, so retrieval quality is plain vector similarity.
- Zero-downtime embedding-model migration (backfill a replacement index before cutover) is not built. Changing the embedding model today means rebuilding the index.
- Sandbox execution audit is not fully persisted, and there is no production runner attestation.
- OIDC/SSO is not wired into the identity boundary.
- SBOM generation and verification as release artifacts.
- A Prisma configuration advisory awaits a tested major-version migration.
- Task-driven PDF page selection exists at the adapter boundary but is not exposed by the run API.

**Deferred UI work** — the browser client trails the desktop client. Task composition with classification warnings, streaming run/tool progress, knowledge-source management, citation display with page/slide/sheet references, reviewer approval queues, deliverable previews, and model-registry administration are all specified against stable backend contracts but not all built in the Next.js surface.

---

## Target state

Today the workbench is upload-and-process: a user hands it one file and gets one result. The production vision is different — the organization's own codebase, documents, and systems live inside the sovereign perimeter permanently, kept in sync, and any employee talks to the workbench like a colleague who already knows everything. Every step, from a question typed in chat to a line of code changed in the repo, is logged.

```mermaid
flowchart LR
  subgraph ORG[Organization's sovereign perimeter — zero internet egress]
    direction TB

    subgraph SOURCES[Their existing systems]
      direction TB
      Git[(Internal git repos)]
      Docs[(Document stores<br/>SharePoint / Confluence / file shares)]
      Wiki[(Internal wikis)]
      IdP[(Identity provider<br/>LDAP / SSO)]
    end

    subgraph INGEST[Continuous ingestion]
      direction LR
      Sync[Repo + doc sync workers]
      Parse[OCR / layout / code parsers]
      EmbedW[Embedding workers]
      Sync --> Parse --> EmbedW
    end

    Git --> Sync
    Docs --> Sync
    Wiki --> Sync

    subgraph STORE[Unified knowledge layer]
      direction TB
      PG[(PostgreSQL<br/>metadata, RBAC, audit)]
      Obj[(Object store<br/>files + code snapshots)]
      Vec[(Vector index<br/>org-wide retrieval)]
    end

    EmbedW --> PG
    EmbedW --> Obj
    EmbedW --> Vec

    IdP --> Auth[Auth + RBAC]

    User([Any employee]) --> Chat[Conversational workbench<br/>one entry point]
    Chat --> Auth
    Auth --> Orchestrator

    subgraph AGENT[Agent orchestrator]
      direction TB
      Orchestrator{Model router}
      Retrieve[Knowledge retrieval]
      CodeTool[Codebase tool<br/>read / edit / propose]
      GenTool[General reasoning]
      Orchestrator --> Retrieve
      Orchestrator --> CodeTool
      Orchestrator --> GenTool
    end

    Retrieve --> Vec
    Retrieve --> Obj
    CodeTool --> Git

    subgraph GATE[Human approval gate]
      Reviewer{{Reviewer / maintainer}}
    end

    CodeTool --> Reviewer

    subgraph EXEC[Isolated execution]
      direction TB
      Sandbox[Sandbox runner]
      Clone[Ephemeral repo clone]
      Sandbox --> Clone
    end

    Reviewer -->|approved| Sandbox
    Clone -->|diff / test results| Orchestrator

    subgraph MODELS[Fully local model layer]
      direction TB
      LLM[Local LLMs]
      VisionM[Local vision models]
      EmbedM[Local embedding models]
    end

    Orchestrator --> LLM
    Orchestrator --> VisionM
    EmbedW --> EmbedM

    subgraph AUDIT[Immutable audit trail]
      direction TB
      Log[(Append-only audit log)]
      Dash[Compliance / ops dashboard]
      Log --> Dash
    end

    Chat -.-> Log
    Auth -.-> Log
    Orchestrator -.-> Log
    Retrieve -.-> Log
    CodeTool -.-> Log
    Reviewer -.-> Log
    Sandbox -.-> Log
    Sync -.-> Log
  end

  classDef ext fill:#FFE2E2,stroke:#C53030,color:#6E1515;
  classDef store fill:#FFF0C2,stroke:#BA7A00,color:#563800;
  classDef safe fill:#E0F7E9,stroke:#198754,color:#114D30;
  classDef gate fill:#F3E8FF,stroke:#6B21A8,color:#3B0764;
  classDef app fill:#DDF4FF,stroke:#1677B8,color:#0B3A58;

  class Git,Docs,Wiki,IdP ext;
  class PG,Obj,Vec,Log store;
  class Sandbox,Clone,LLM,VisionM,EmbedM safe;
  class Reviewer gate;
  class Chat,Orchestrator,Retrieve,CodeTool,GenTool,Auth,Sync,Parse,EmbedW,Dash app;
```

What changes from today:

- **No more upload-and-get-a-result.** The repos, documents, and wikis are already inside the perimeter and stay in sync on their own. The user just asks.
- **One chat entry point** instead of separate upload and task flows — the workbench decides whether it needs to search documents, read code, or both.
- **The codebase is a tool**, not a one-off attachment. The agent reads it and proposes changes; only a human decides whether those changes touch the real repo.
- **Every hop writes to the same append-only audit log** — chat, auth, router, tool, reviewer, sandbox, sync — feeding a dashboard someone can actually check later.
- Still zero internet egress, still local models only. This scales up what lives inside the wall, not what is allowed to leave it.

---

## Appendix A — earlier diagrams

Kept verbatim for reference. The extended versions above supersede them; these are the originals as they appeared in the presentation and target-state notes.

### A.1 Original architecture diagram

```mermaid
flowchart LR
  User([User]) --> UI[Web Workbench]

  subgraph APP[SIH-26117 Platform]
    UI --> API[API + RBAC]
    API --> Queue[[Durable Queue]]
    Queue --> Agent[Agent Worker]
    Agent --> Router{Model Router}
    Agent --> Doc[Document + OCR Tool]
    Agent --> Code[Code Tool]
  end

  subgraph APPROVAL[Human Approval Gate]
    Reviewer{{Reviewer}}
  end
  Code --> Reviewer

  subgraph SANDBOX[Isolated Code Sandbox]
    Runner[Sandbox Runner] --> Box[Temporary Container]
  end
  Reviewer -->|approved| Runner
  Box -->|stdout / stderr| Agent

  subgraph DATA[Local Data Layer]
    DB[(PostgreSQL)]
    Files[(MinIO)]
    Vector[(Qdrant)]
  end

  API --> DB
  Agent --> DB
  Agent --> Files
  Agent -.-> Vector
  Doc --> Files

  subgraph MODELS[Model Layer]
    Dev[Remote Providers<br/>Development]
    Local[Local Open-Weight Models<br/>Sovereign Mode]
  end
  Router --> Dev
  Router -.-> Local

  subgraph SECURITY[Security Boundary]
    Internal[Internal Network]
    Airgap[No Internet Egress]
  end
  API -.-> Internal
  DB -.-> Internal
  Files -.-> Internal
  Local -.-> Airgap
  Box -.->|network none| Airgap

  classDef app fill:#DDF4FF,stroke:#1677B8,color:#0B3A58;
  classDef data fill:#FFF0C2,stroke:#BA7A00,color:#563800;
  classDef safe fill:#E0F7E9,stroke:#198754,color:#114D30;
  classDef dev fill:#FFE2E2,stroke:#C53030,color:#6E1515;
  classDef gate fill:#F3E8FF,stroke:#6B21A8,color:#3B0764;

  class UI,API,Agent,Router,Doc,Code,Queue app;
  class DB,Files,Vector data;
  class Runner,Box,Internal,Airgap,Local safe;
  class Dev dev;
  class Reviewer gate;
```

Notes that accompanied it, still accurate:

- **Workbench** — uploads, tasks, generated artifacts, run trace.
- **Durable queue → agent worker** — the API does not execute anything itself. It writes the run to PostgreSQL and hands it to RabbitMQ; a separate worker executes it, recording every tool call, evidence item, and audit event. That is why a run survives a restart mid-flight instead of vanishing.
- **PostgreSQL** — identity, RBAC, workspaces, runs, tool traces, evidence, audit. **MinIO** — files, extracted text, citation metadata.
- **Document + OCR tool** — plain text plus OCR/layout extraction for PDFs, images, and Office files, so scanned documents are not a dead end.
- **Human approval gate** — code does not run automatically; the reviewer approves the exact code before it reaches the sandbox.
- Untrusted code never runs inside the API.
- "Remote providers" is development-only and only ever sees data explicitly marked public or synthetic. The sovereign deployment removes it entirely.

The one thing this diagram now understates: the agent worker is a model-driven loop, not a fixed document-then-code pipeline, and there is a second client (the Electron workbench) alongside the web UI.

### A.2 Original target-state diagram

The target-state diagram above is the original from the production-vision notes, carried forward unchanged apart from label casing. No separate copy is needed.

---

## Appendix B — what happened to the old docs

This file replaces nine documents that had drifted apart. They remain in git history if you need the exact prior wording.

| Removed | Now in |
|---|---|
| `END_TO_END.md` | This file, throughout |
| `MODEL_CONFIGURATION.md` | [Model registry and routing](#model-registry-and-routing) |
| `JOB_EXECUTION.md` | [Durable execution](#durable-execution), [Approval gate](#approval-gate) |
| `DOCUMENT_UNDERSTANDING.md` | [Document ingestion and understanding](#document-ingestion-and-understanding) |
| `API.md` | [API surface](#api-surface) |
| `OPERATIONS.md` | [Operations runbook](#operations-runbook), [Observability](#observability) |
| `VERIFICATION.md` | [Verification](#verification) |
| `REMOTE_PROVIDERS.md` | [Model environment variables](#model-environment-variables) |
| `BACKEND_ROADMAP.md` | [Status — built vs not built](#status--built-vs-not-built) |
| `FRONTEND_BACKLOG.md` | [Status — built vs not built](#status--built-vs-not-built), deferred UI work |
| `../ppt.md` | [PRESENTATION.md](./PRESENTATION.md), [Appendix A](#appendix-a--earlier-diagrams) |
| `../new.md` | [Target state](#target-state) |

The main corrections made while consolidating: the agent is a model-driven loop and the `SOURCE/ANALYZE/ACTION/FINALIZE` phase cursor no longer exists; there are nine tools, not six; the sovereignty posture, egress-ledger, and egress-probe APIs and the Electron client's governance views were undocumented; a local embedding profile now exists in the registry; and the base Compose file publishes the API on `4000`, which the old docs attributed to the dev override only.
