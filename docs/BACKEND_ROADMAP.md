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

- [ ] Replace hard-coded profiles with a validated model registry.
- [ ] Support multiple OpenRouter and local OpenAI-compatible models per capability.
- [ ] Route general, document, vision, code, embedding, and reranking workloads independently.
- [ ] Add deterministic priorities and configurable fallback chains.
- [ ] Add provider timeouts, cancellation signals, bounded retries, and normalized failures.
- [ ] Persist provider, model, latency, token usage, finish reason, and estimated cost.
- [ ] Add capability and availability checks without sending document content.

Acceptance gate: at least two task capabilities select different configured models, provider failures follow policy, and confidential data cannot reach an external provider.

## Phase 2: Durable execution

Status: pending

- [ ] Add BullMQ with a lightweight Redis-compatible service.
- [ ] Move agent processing from the API process into a dedicated worker.
- [ ] Make enqueueing idempotent and recover database/queue inconsistencies.
- [ ] Add bounded retries, backoff, timeouts, progress events, and failure reasons.
- [ ] Implement real cancellation using worker and tool abort signals.
- [ ] Recover or fail stale runs after worker restarts.
- [ ] Enforce global, workspace, and user concurrency limits.

Acceptance gate: queued work survives API restarts, cancellation stops active processing, and duplicate delivery cannot duplicate tool side effects.

## Phase 3: Identity and authorization

Status: pending

- [ ] Add refresh sessions, logout, revocation, and disabled-user checks.
- [ ] Add Admin-managed users and workspace memberships.
- [ ] Enforce Admin, Operator, and Reviewer permissions at service boundaries.
- [ ] Add login throttling and failed-authentication auditing.
- [ ] Add reviewer decisions and comments for approval-gated actions.
- [ ] Keep the identity boundary ready for a future OIDC adapter.

Acceptance gate: every protected resource is tenant-scoped, revoked sessions stop working, and role tests cover allowed and denied operations.

## Phase 4: Artifact ingestion

Status: pending

- [ ] Validate file signatures, extensions, MIME types, sizes, and archive expansion limits.
- [ ] Add artifact listing, metadata, versioning, deletion, and retention states.
- [ ] Integrate layout-aware PDF, image, DOCX, PPTX, XLSX, CSV, and text extraction.
- [ ] Run OCR for scanned pages and preserve page, table, image, slide, and sheet locations.
- [ ] Store canonical extracted content and checksums in MinIO.
- [ ] Reconcile failed database and object-storage operations.

Acceptance gate: supported fixtures produce bounded structured extraction, unsafe files fail closed, and partial failures leave no untracked objects.

## Phase 5: Knowledge retrieval

Status: pending

- [ ] Add local CPU embedding with pinned model files for offline deployment.
- [ ] Chunk extracted content while preserving source locations and hierarchy.
- [ ] Index workspace-private and organization-shared knowledge in Qdrant.
- [ ] Enforce access-control filters on every retrieval query.
- [ ] Add optional local reranking and deterministic citation assembly.
- [ ] Add re-indexing, deletion, model-version migration, and index reconciliation.
- [ ] Build a small retrieval evaluation dataset from licensed public or synthetic documents.

Acceptance gate: retrieval returns only authorized passages with resolvable citations and can rebuild Qdrant entirely from durable records.

## Phase 6: Agent runtime and approvals

Status: pending

- [ ] Replace the fixed workflow with a bounded plan-act-observe loop.
- [ ] Register typed tools with validated inputs, outputs, permissions, and idempotency keys.
- [ ] Enforce maximum turns, tool calls, token budgets, and execution deadlines.
- [ ] Require human approval before code execution and future consequential actions.
- [ ] Resume paused runs after approval without replaying completed tools.
- [ ] Separate sourced evidence from model-generated analysis.
- [ ] Persist concise progress events without exposing hidden reasoning.

Acceptance gate: a scanned-report workflow plans, retrieves, requests required approval, generates a cited deliverable, and can resume safely after interruption.

## Phase 7: Code sandbox

Status: pending

- [ ] Support curated Python and JavaScript runtime images.
- [ ] Replace bind-path assumptions with controlled input and output transfer.
- [ ] Add authenticated asynchronous runner jobs and idempotent cancellation.
- [ ] Enforce non-root users, no network, read-only roots, resource limits, bounded output, and immutable images.
- [ ] Preload all runtime images and dependencies for air-gapped operation.
- [ ] Add stale-container cleanup and execution audit records.
- [ ] Document lower-assurance Windows development and isolated Linux production deployment.

Acceptance gate: generated Python and JavaScript execute, failures can be repaired and retried, cancellation removes containers, and jobs cannot access application data or networks.

## Phase 8: Deliverables

Status: pending

- [ ] Generate approval-note DOCX files from structured evidence and templates.
- [ ] Generate PPTX presentations with editable content and source references.
- [ ] Generate XLSX workbooks with formulas, units, assumptions, and calculation steps.
- [ ] Persist deliverable versions and links to source evidence.
- [ ] Validate generated Office package structure before publication.
- [ ] Preserve the source run classification on every generated artifact.

Acceptance gate: DOCX, PPTX, XLSX, and code outputs open successfully, remain editable, and trace every factual claim to available evidence.

## Phase 9: API and operations

Status: pending

- [ ] Version the API and publish generated OpenAPI 3.1 documentation.
- [ ] Add pagination, filtering, stable sorting, and consistent resource envelopes.
- [ ] Add request IDs, access logs, redaction, metrics, and structured error logging.
- [ ] Separate liveness from dependency-aware readiness checks.
- [ ] Add audit search and export APIs.
- [ ] Record external-provider attempts and provide visible zero-egress evidence in sovereign mode.
- [ ] Pin container versions, add health checks, graceful shutdown, and resource limits.

Acceptance gate: operators can diagnose every failed dependency or run, API contracts are machine-tested, and sovereign deployment evidence is reproducible.

## Phase 10: Release hardening

Status: pending

- [ ] Add unit, integration, contract, security, and end-to-end acceptance suites.
- [ ] Add CI gates for tests, types, build, migrations, OpenAPI, dependencies, and container scanning.
- [ ] Add backup, restore, retention, disaster-recovery, and upgrade procedures.
- [ ] Resolve the Prisma configuration advisory through a tested major-version migration.
- [ ] Create an offline deployment bundle with checksums, model manifests, images, and SBOMs.
- [ ] Run acceptance scenarios using licensed public or synthetic demonstration fixtures.

Acceptance gate: a clean machine can install and run the documented demonstration without internet access, and all acceptance workflows pass from uploaded source to downloadable deliverable.

## Immediate commit sequence

1. Add a validated model registry with capability-based priorities.
2. Add provider timeout, normalized responses, and failure tests.
3. Persist model invocation usage and audit metadata.
4. Add Redis-compatible queue infrastructure and worker entrypoint.
5. Move run processing into durable BullMQ jobs.
6. Add cancellation, retries, recovery, and progress events.

The sequence may be adjusted only when a discovered dependency or security defect must be resolved first.
