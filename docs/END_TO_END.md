# How SIH-26117 works

This is the connective-tissue doc — what happens end to end when someone uses the system, and how the pieces fit together. Each subsystem has its own deep-dive doc linked inline; this one is the map.

## What it actually is

An internal workbench for confidential industrial work: upload a document, ask for an approval note / analysis / code, get back a real deliverable with citations back to source evidence, and a full audit trail of what happened. Every piece of state lives in services the org controls — Postgres, MinIO, Qdrant, RabbitMQ — with the model layer swappable between a local endpoint and a remote one.

## Sovereign vs air-gapped

**Sovereign** means the org controls the data stores, the model endpoint, access control, and the logs. **Air-gapped** is stronger — no route to the public internet at all, enforced by network policy, not app logic.

Concretely:
- Remote inference (OpenRouter, Groq, Gemini, Mistral, Cloudflare) only fires when `ALLOW_REMOTE_INFERENCE=true`, the target profile's provider is marked `remote`, the relevant API key env var is set, the task/source data is classified `PUBLIC` or `SYNTHETIC`, and the backend has an egress-capable network attached. Any one of those being false blocks the call before anything is sent.
- `docker-compose.sovereign.yml` sets `ALLOW_REMOTE_INFERENCE=false`, strips remote credentials, and replaces the backend's network list with the internal-only network — no `development-egress` attachment at all. Only providers marked `local` remain reachable.
- `INTERNAL`/`CONFIDENTIAL` classified data can never reach a remote provider regardless of the flag — that check happens independent of the sovereign/dev toggle.

Sovereign mode still needs the org to actually block egress at the host firewall — Compose removes the app's own path out, but it isn't a substitute for network-level enforcement.

## The stack

| Service | Role |
|---|---|
| `backend` | Express API — auth, workspaces, artifacts, runs, approvals, knowledge, admin/ops endpoints |
| `worker` | Consumes agent-run and knowledge jobs from RabbitMQ, does the actual work |
| `frontend` | Next.js workbench UI |
| `postgres` | System of record — users, workspaces, runs, tool calls, evidence, artifacts, audit, knowledge metadata |
| `minio` | Durable object storage — uploaded files, extracted text/provenance sidecars, generated deliverables |
| `qdrant` | Vector index for knowledge retrieval — rebuildable from Postgres, not itself a source of truth |
| `rabbitmq` | Durable transport for agent and knowledge jobs |
| `docling` | Optional CPU-only extraction service — OCR, layout, tables for PDF/image/DOCX/PPTX/XLSX |
| `pdf-renderer` | Isolated sidecar that rasterizes PDF pages to PNG for vision models |
| `sandbox-runner` | Spins up disposable, network-less Docker containers for generated code |

## Auth and workspaces

Users have a global role — `ADMIN`, `OPERATOR`, or `REVIEWER` — plus per-workspace membership that can differ from that global role (e.g. someone globally `OPERATOR` can still hold `REVIEWER` membership on a specific workspace and approve things there). Login issues a JWT plus a refresh session; sessions can be revoked, logout invalidates them, disabled users are rejected, and repeated failed logins are throttled and audited.

Everything below — uploads, runs, knowledge, approvals — is scoped to a workspace and checked against membership before it executes.

## Uploading and ingesting a document

1. File is validated: signature, extension, MIME type, UTF-8 where relevant, 25 MiB cap.
2. It's written to MinIO; Postgres gets the metadata row, including an optional `previousArtifactId` (version lineage) and `retentionUntil`.
3. Extraction kicks in based on type:
   - Plain UTF-8 text, Markdown, CSV → decoded locally, no external service.
   - PDF, image, DOCX, PPTX, XLSX → sent to the internal **Docling** service for OCR/layout/table extraction. Docling being down doesn't block the worker or unrelated tasks — extraction just fails for that artifact and vision-only analysis can still proceed.
4. Two things get persisted to MinIO: the canonical extracted text/Markdown, and a separate versioned JSON **provenance sidecar** — page numbers, bounding boxes, table/picture/heading identity, character ranges — with a SHA-256 checksum recorded in Postgres. This sidecar is what later lets a citation point back to an exact page/region instead of just "somewhere in the document."
5. Extraction status (`PENDING` → `PROCESSING` → `COMPLETED`/`FAILED`) and timing are tracked per artifact.

Full detail: [DOCUMENT_UNDERSTANDING.md](./DOCUMENT_UNDERSTANDING.md).

## Submitting a task (an agent run)

`POST /api/workspaces/{id}/runs` doesn't run anything inline — it opens a Postgres transaction that creates the `AgentRun` row and an outbox event together, then returns. A background dispatcher publishes that event to RabbitMQ; a worker picks it up. This means the run survives an API restart between "accepted" and "started."

Admission control happens at two points:
- The API refuses a new run with `409` if the workspace already has one queued/running/waiting-on-approval, and `429` if the requester has hit their cross-workspace concurrency limit (`AGENT_MAX_CONCURRENT_RUNS_PER_USER`).
- The worker claims at most `QUEUE_PREFETCH` `RUNNING` rows globally (across all worker replicas) via an advisory lock. If capacity is full, the job just waits — it's rescheduled, not treated as a failed retry.

Each accepted run snapshots its budget up front: max turns, max tool calls, input/output/total token limits, and an absolute deadline. These are enforced cumulatively across provider fallbacks — if a budget is exhausted the run terminates rather than silently retrying forever.

The worker advances a persisted phase cursor: `SOURCE → ANALYZE → ACTION → FINALIZE`. Concise progress events get written at each step — never raw model reasoning/chain-of-thought.

### Tools

Registered tools, by risk level:

| Tool | Risk | Approval required |
|---|---|---|
| `artifact.read` | LOW | no |
| `knowledge.search` | LOW | no |
| `deliverable.createApprovalNote` | MEDIUM | no |
| `deliverable.createPresentation` | MEDIUM | no |
| `deliverable.createSpreadsheet` | MEDIUM | no |
| `sandbox.execute` | HIGH | **yes** |

Every tool call is schema-validated and persisted with its exact input before it runs. `sandbox.execute` is the one high-risk case today: the worker atomically writes a `WAITING_APPROVAL` tool call plus an approval row (input frozen immutable by a DB trigger), parks the run in `WAITING_APPROVAL`, and releases its lease. A workspace `REVIEWER` or `ADMIN` decides via `POST /api/agent-approvals/:id/decision`. Approve → the exact frozen input runs once, run resumes. Reject → the tool result comes back to the model as denied, no code executes.

Evidence produced along the way is tagged `SOURCE` (grounded in an actual document/tool result) or `MODEL_OUTPUT` (the model said it) — kept as separate lists on the run so a deliverable's claims can be checked against what's actually backed by something.

Full detail: [JOB_EXECUTION.md](./JOB_EXECUTION.md).

## Model routing

`backend/config/models.json` is the whole story — two lists, `providers` and `models`. A provider is `local` or `remote`, has an OpenAI-compatible `baseUrl`, and optionally a credential env var. A model profile references a provider, declares capabilities (`general`, `document`, `vision`, `code`, `embedding`, `reranking`), and a priority — lower number wins, everything else with a matching capability becomes an ordered fallback.

Nothing in the routing code knows vendor names — "OpenRouter" or "Groq" only exist as entries in that JSON file. The current dev registry, for example, prioritizes free OpenRouter models first, then Groq/Gemini/Mistral/Cloudflare as paid fallbacks, then a `local-runtime` provider (Ollama-shaped, pointed at `host.docker.internal:11434`) last. Swapping models is a config change, not a code change.

Two capability types have extra required metadata:
- **Embedding** profiles declare an immutable `revision`, exact `dimensions`, `distance` function, and batch/character limits. A Qdrant index is bound to one profile's revision/dimensions/distance permanently — there's no silent fallback to a different embedding profile for an existing index, since that would mix incompatible vector spaces.
- **Reranking** profiles (none configured today) would need `revision`, `maxDocuments`, and character limits. With none configured, retrieval just keeps plain vector-similarity order.

Every invocation attempt — provider, profile, model, status, latency, tokens, finish reason, sanitized failure, and (if the profile has pricing metadata) an estimated micro-USD cost — gets persisted. `GET /api/admin/model-providers/status` does a content-free `GET /models` probe against each configured provider to report live availability without ever sending prompt or document data.

Full detail: [MODEL_CONFIGURATION.md](./MODEL_CONFIGURATION.md).

## Vision and multimodal input

Vision-capable profiles get bounded PNG/JPEG/WEBP originals sent alongside the deterministic OCR text, not instead of it. For a vision-routed PDF, the internal `pdf-renderer` sidecar rasterizes a deterministic page selection (every page if ≤3 pages, else first/middle/last) — it's an isolated, no-egress, read-only Node service using PDF.js, so a hostile PDF can't do much even if it exploited the renderer. Rendered pages and the base64 sent to the provider are never persisted or logged — only descriptors of what was sent. Vision output is treated as model analysis, not source evidence — anything cited still has to resolve to a real page/region from the provenance sidecar.

## Knowledge retrieval (Qdrant)

Extracted content is chunked (preserving the provenance locations from ingestion), embedded using the one enabled text-embedding profile, and indexed into Qdrant — either `WORKSPACE_PRIVATE` or `ORGANIZATION_SHARED`. Indexing and querying both run as jobs through the worker, not inline in the API. Every retrieval query is filtered by workspace access and classification before results come back, so nothing is exposed across workspace boundaries.

Qdrant itself is treated as a rebuildable cache, not a system of record — Postgres tracks source/index state well enough that `POST /api/admin/knowledge-indexes/rebuild` can regenerate it from scratch. Deleting a knowledge source marks it non-retrievable immediately, then a background job removes its points from every linked collection; a periodic reconciliation job also catches orphaned points and stale index rows.

This part is still thin in practice — chunking/indexing/retrieval exist, but there's no local CPU embedding model wired up for a fully offline path yet, and reranking has no configured profile.

## Code execution

`sandbox.execute` (after approval, see above) is sent to the `sandbox-runner` service over the internal network. It spins up a disposable container per job — curated Python or Node image, non-root, read-only root filesystem, no network, dropped Linux capabilities, CPU/memory/PID/time limits — captures stdout/stderr/exit code, and tears the container down. Sandbox images are pulled once and pinned (`--pull never` at runtime) so nothing gets fetched mid-demo. The API process itself never executes code.

## Deliverables

Three generated formats today: DOCX approval notes, PPTX presentations, XLSX workbooks (with formulas/units/assumptions, not just static values). Each is generated from persisted evidence, versioned as an artifact, linked back to its source run, and validated structurally before it's exposed for download. Generated artifacts inherit the data classification of the run that produced them — a confidential source can't produce a deliverable that reads as public.

## Artifact lifecycle

Artifacts move `ACTIVE → DELETING → DELETED`. Deletion requires workspace `ADMIN`, is rejected while retention applies or a non-terminal run/extraction/indexing job still references the artifact, and runs asynchronously as a durable job — MinIO objects and any knowledge vectors get cleaned up, metadata stays queryable for audit. Repeating a delete request is safe; it just requeues whatever didn't finish.

## API and operations

- OpenAPI 3.1 contract served live at `GET /openapi.json`, version-tracked independently of the app version.
- `GET /health` is unauthenticated liveness only (no dependency I/O). `GET /ready` (admin-only) checks Postgres/MinIO/RabbitMQ/Qdrant/sandbox/Docling concurrently — Docling failing doesn't fail readiness unless `DOCLING_REQUIRED=true`.
- `GET /metrics` (admin-only) is Prometheus text exposition with low-cardinality labels — method, route template, status code — never workspace/user/prompt content.
- Audit events are queryable per workspace; JSON/NDJSON export requires workspace `ADMIN`. Every persisted audit record is already sanitized — no secrets, no raw payloads.

## Running it

Dev mode:
```bash
cp .env.example .env
docker compose up --build
```
`ALLOW_REMOTE_INFERENCE` can be `true` here — set only if you're prepared to send whatever you upload to OpenRouter/Groq/etc. Anything not classified `PUBLIC`/`SYNTHETIC` still won't leave, regardless of this flag.

Sovereign mode:
```bash
docker compose -f docker-compose.yml -f docker-compose.sovereign.yml up --build
```
Needs a local model endpoint already reachable (registry defaults assume something Ollama-shaped at `host.docker.internal:11434`). No image gets auto-pulled for that — you bring your own local runtime.

Local development with hot reload — no rebuild needed after editing code:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build backend worker frontend
```
This overrides `backend`, `worker`, and `frontend` to bind-mount source and run `tsx watch` / `next dev` instead of the built output; `node_modules` for each stays in a named volume so host and container installs don't collide. Data services (Postgres, MinIO, Qdrant, RabbitMQ, Docling, the sandbox runner, the PDF renderer) are unaffected and can keep running from the base compose file. Not for sovereign/production use — the dev images keep devDependencies and run as root.

Model behavior — which providers/models exist, priorities, pricing — is entirely `backend/config/models.json`; no code changes needed to add or swap a model.

## What's not actually done yet

Being straight about the gaps, since it's easy to over-claim from the docs above:

- No local CPU embedding model pinned for a fully offline knowledge pipeline — embedding profiles today are all remote or assume an external local runtime.
- No reranking profile configured — retrieval quality is plain vector similarity.
- Tool orchestration is still a fixed, worker-driven phase loop (`SOURCE/ANALYZE/ACTION/FINALIZE`), not a model-driven "pick your own next action" loop.
- Sandbox execution audit is not fully persisted yet, and there's no production runner attestation.
- Zero-downtime embedding-model migration (backfill a replacement index before cutover) isn't built — changing the embedding model today means rebuilding the index.
- OIDC/SSO is not wired into the identity boundary, just left room for.

The [BACKEND_ROADMAP.md](./BACKEND_ROADMAP.md) has the authoritative phase-by-phase status if you need more than this summary, and [FRONTEND_BACKLOG.md](./FRONTEND_BACKLOG.md) covers what the UI still doesn't expose.
