# Frontend integration backlog

Frontend implementation is deferred while backend contracts and workflows are completed. No frontend item should begin until its listed backend dependency is stable and covered by integration tests.

## Authentication and access

- Replace the single-page demo login with session-aware authentication and logout.
- Add Admin, Operator, and Reviewer experiences based on API-provided permissions.
- Add workspace creation, selection, membership management, and role assignment.
- Handle authentication expiry, forbidden actions, validation failures, and rate limits consistently.

Backend dependencies: session APIs, user administration, workspace membership APIs, permission fields, and the shared error contract.

## Workbench and runs

- Build task composition with artifact selection, capability hints, and data-classification warnings.
- Show queued, running, awaiting-approval, completed, failed, and cancelled run states.
- Stream run progress and tool activity without exposing hidden model reasoning.
- Add reliable cancellation, retry, and failure-recovery actions.
- Display selected model, routing reason, provider mode, token usage, and estimated cost.

Backend dependencies: durable run APIs, progress events, approval APIs, cancellation, retry semantics, and model-usage records.

## Evidence and knowledge

- Add knowledge-source upload, ingestion progress, re-index, and removal controls.
- Display grounded citations with document, page, section, slide, sheet, or image references.
- Distinguish workspace knowledge from organization-shared knowledge.
- Show extraction or OCR warnings and allow source previews where permitted.

Backend dependencies: ingestion jobs, scoped retrieval APIs, citation schemas, extraction metadata, and knowledge ACLs.

## Approvals and deliverables

- Add Reviewer approval queues with approve, reject, request-changes, and comment actions.
- Show pending high-risk tool requests before code execution or consequential actions.
- Preview and download generated DOCX, PPTX, XLSX, code, and sandbox output artifacts.
- Preserve deliverable versions and their source evidence links.

Backend dependencies: approval state machine, tool authorization APIs, artifact listing/versioning, and authenticated downloads.

## Administration and sovereignty

- Add model registry, capability, availability, and routing-policy administration.
- Display development, sovereign, and degraded operating modes accurately.
- Add audit-event search and export with actor, workspace, run, and event filters.
- Show provider-call records and network-egress evidence for sovereign demonstrations.
- Add service readiness for database, object storage, queue, vector store, parser, model, and sandbox services.

Backend dependencies: model administration, operating-mode API, audit APIs, egress evidence, and readiness checks.

## Quality requirements

- Support desktop and mobile layouts with keyboard-accessible workflows.
- Generate frontend API types from the versioned OpenAPI contract.
- Add component, accessibility, contract, and end-to-end tests for each completed workflow.
- Avoid hard-coded credentials, provider labels, workspace IDs, model names, and polling intervals.
