# Backend delivery roadmap

This roadmap tracks the production-shaped backend required for the SIH sovereign industrial AI demonstration. Backend contracts and workflows are the active scope. Frontend implementation remains deferred in [FRONTEND_BACKLOG.md](./FRONTEND_BACKLOG.md).

## Delivery rules

- Complete work in dependency order and keep every commit narrowly scoped.
- Use Conventional Commit messages containing 10-20 words and no co-author metadata.
- Commit only after relevant tests, typecheck, build, schema validation, and infrastructure validation pass.
- Keep OpenRouter restricted to explicitly classified public or synthetic demonstration data.
- Keep all model, embedding, parser, storage, and sandbox integrations replaceable through typed boundaries.
- Treat PostgreSQL as the system of record, MinIO as durable file storage, and Qdrant as a rebuildable retrieval index.
- Do not claim sovereign or secure behavior unless it is enforced and testable.

## Phase 0: Security foundation

Status: completed

- [x] Add backend API test harness and stable JSON errors.
- [x] Enforce workspace authorization for run reads and cancellation.
- [x] Protect terminal run states with atomic status transitions.
- [x] Remove backend egress and OpenRouter credentials from rendered sovereign Compose configuration.
- [x] Add artifact and task data classification.
- [x] Block external inference for internal and confidential data.
- [x] Upgrade vulnerable upload middleware and remove unused AI SDK dependencies.

Acceptance gate: tests, typecheck, build, Prisma validation, and rendered sovereign Compose validation pass.

## Phase 1: Model platform

Status: in progress

- [x] Replace hard-coded profiles with a validated model registry.
- [x] Support multiple OpenRouter and local OpenAI-compatible models per capability.
- [x] Route general, document, vision, code, and embedding workloads independently.
- [ ] Add a dedicated reranking workload and provider boundary.
- [x] Add deterministic priorities and ordered fallback execution across eligible profiles.
- [x] Add provider timeouts, cancellation signals, bounded provider-failure retries, and normalized failures.
- [x] Persist provider, profile, model, attempt status, latency, token usage, finish reason, and sanitized failures.
- [x] Send bounded PNG, JPEG, and WEBP originals with extraction text to vision profiles without persisting image payloads.
- [ ] Persist estimated invocation cost from versioned provider pricing metadata.
- [ ] Add provider capability and availability probes without sending document content.

Acceptance gate: at least two task capabilities select different configured models, provider failures follow policy, and confidential data cannot reach an external provider.

## Phase 2: Durable execution

Status: in progress

- [x] Add RabbitMQ with durable exchanges, queues, publisher confirms, and manual acknowledgements.
- [x] Move agent processing from the API process into a dedicated worker.
- [x] Make enqueueing idempotent and recover database/queue inconsistencies.
- [x] Add bounded retries, backoff, timeouts, progress events, and failure reasons.
- [x] Implement real cancellation using worker and tool abort signals.
- [x] Recover or fail stale runs after worker restarts.
- [x] Enforce global, workspace, and user concurrency limits.

Acceptance gate: queued work survives API restarts, cancellation stops active processing, and duplicate delivery cannot duplicate tool side effects.

## Phase 3: Identity and authorization

Status: in progress

- [x] Add refresh sessions, logout, revocation, and disabled-user checks.
- [x] Add Admin-managed users and workspace memberships.
- [x] Enforce Admin, Operator, and Reviewer permissions at service boundaries.
- [x] Add login throttling and failed-authentication auditing.
- [x] Add reviewer decisions and comments for approval-gated actions.
- [ ] Keep the identity boundary ready for a future OIDC adapter.

Acceptance gate: every protected resource is tenant-scoped, revoked sessions stop working, and role tests cover allowed and denied operations.

## Phase 4: Artifact ingestion

Status: pending

- [x] Validate supported file signatures, extensions, MIME types, UTF-8 encoding, and 25 MiB upload size.
- [x] Add workspace-scoped artifact listing and metadata APIs.
- [x] Add artifact version lineage, retention timestamps, and explicit `ACTIVE`, `DELETING`, and `DELETED` lifecycle states.
- [x] Add workspace-Admin soft deletion with an enforced run relation, transactional outbox job, retry-safe MinIO/Qdrant cleanup, and stale-job reconciliation while retaining audit metadata.
- [x] Integrate local UTF-8 and internal Docling extraction for PDF, image, DOCX, PPTX, XLSX, CSV, Markdown, and text.
- [x] Run OCR for PDF/image inputs and preserve Docling's layout-aware Markdown structure.
- [ ] Persist granular page, table, image, slide, and sheet location metadata for citation assembly.
- [x] Render and deterministically select bounded PDF pages for vision inference through the isolated internal renderer.
- [x] Store canonical extracted content and checksums in MinIO with retry-safe lifecycle metadata.
- [x] Reconcile expired artifact-deletion claims and safely repeat physical object cleanup.

Acceptance gate: supported fixtures produce bounded structured extraction, unsafe files fail closed, and partial failures leave no untracked objects.

## Phase 5: Knowledge retrieval

Status: in progress

- [x] Pin and authenticate Qdrant; add readiness and validated named-vector collection administration.
- [ ] Add local CPU embedding with pinned model files for offline deployment.
- [x] Chunk extracted content while preserving source locations and hierarchy.
- [x] Index workspace-private and organization-shared knowledge in Qdrant.
- [x] Enforce access-control filters on every retrieval query.
- [x] Provision the active index and execute indexing and query jobs in the backend worker.
- [ ] Add optional local reranking.
- [x] Add deterministic citation assembly.
- [x] Add knowledge-source deletion, an explicit active-index rebuild, and periodic index reconciliation. Artifact cleanup removes vectors for already inactive sources.
- [ ] Add zero-downtime model-version migration with replacement-index backfill before activation.
- [x] Build a small retrieval evaluation dataset from licensed public or synthetic documents.

Acceptance gate: retrieval returns only authorized passages with resolvable citations and can rebuild Qdrant entirely from durable records.

## Phase 6: Agent runtime and approvals

Status: in progress

- [x] Replace the fixed workflow with a persisted bounded phase loop.
- [x] Register typed tools with validated inputs, risk policy, and idempotency keys.
- [x] Enforce maximum turns, tool calls, per-run token budgets, and execution deadlines.
- [x] Require human approval before code execution and future high-risk actions.
- [x] Resume paused runs after approval without replaying completed tool side effects.
- [x] Separate sourced evidence from model-generated output.
- [x] Persist concise progress events without exposing hidden reasoning.

Acceptance gate: a scanned-report workflow plans, retrieves, requests required approval, generates a cited deliverable, and can resume safely after interruption.

## Phase 7: Code sandbox

Status: pending

- [x] Support curated Python and JavaScript runtime images.
- [x] Replace bind-path assumptions with controlled input and output transfer.
- [x] Add authenticated asynchronous runner jobs and idempotent cancellation.
- [x] Enforce non-root users, no network, read-only roots, resource limits, bounded output, and immutable images.
- [x] Preload all runtime images and dependencies for air-gapped operation.
- [x] Add stale-container cleanup.
- [ ] Persist complete sandbox execution audit events and production runner attestations.
- [x] Document lower-assurance Windows development and isolated Linux production deployment.

Acceptance gate: generated Python and JavaScript execute, failures can be repaired and retried, cancellation removes containers, and jobs cannot access application data or networks.

## Phase 8: Deliverables

Status: pending

- [x] Generate approval-note DOCX files from structured evidence and templates.
- [x] Generate PPTX presentations with editable content and source references.
- [x] Generate XLSX workbooks with formulas, units, assumptions, and calculation steps.
- [x] Persist deliverable versions and links to source evidence.
- [x] Validate generated Office package structure before publication.
- [x] Preserve the source run classification on every generated artifact.

Acceptance gate: DOCX, PPTX, XLSX, and code outputs open successfully, remain editable, and trace every factual claim to available evidence.

## Phase 9: API and operations

Status: pending

- [x] Version the API and publish validated OpenAPI 3.1 documentation.
- [x] Add pagination, filtering, stable sorting, and consistent resource envelopes.
- [x] Add request IDs, access logs, redaction, metrics, and structured error logging.
- [x] Separate liveness from dependency-aware readiness checks.
- [x] Add audit search and export APIs.
- [x] Record every eligible local and external provider invocation attempt.
- [x] Provide reproducible zero-egress configuration evidence in sovereign mode.
- [x] Pin container versions, add health checks, graceful shutdown, and resource limits.

Acceptance gate: operators can diagnose every failed dependency or run, API contracts are machine-tested, and sovereign deployment evidence is reproducible.

## Phase 10: Release hardening

Status: pending

- [x] Add unit, integration, contract, security, and end-to-end acceptance suites.
- [x] Add CI gates for tests, types, build, migrations, OpenAPI, and containers.
- [x] Add backup, restore, retention, disaster-recovery, and upgrade procedures.
- [ ] Resolve the Prisma configuration advisory through a tested major-version migration.
- [x] Document offline deployment bundles with checksums, model manifests, and images.
- [ ] Generate and verify SBOMs as release artifacts.
- [x] Run acceptance scenarios using licensed public or synthetic demonstration fixtures.

Acceptance gate: a clean machine can install and run the documented demonstration without internet access, and all acceptance workflows pass from uploaded source to downloadable deliverable.

## Immediate commit sequence

1. Add bounded execution progress events and failure details.
2. Add provider capability and availability checks without document content.

The sequence may be adjusted only when a discovered dependency or security defect must be resolved first.
