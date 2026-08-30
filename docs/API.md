# Backend API contract

The backend serves its OpenAPI contract at `GET /openapi.json`. The document uses OpenAPI 3.1.0 and carries the independently versioned API contract version in `info.version`.

The contract covers health and authenticated operational readiness/metrics/model-provider status, authentication sessions, user administration, workspace membership, workspace audit events, artifacts, agent runs, tool approvals, knowledge sources, and knowledge queries. Protected operations use the JWT bearer token returned by `POST /api/auth/login`:

```text
Authorization: Bearer <token>
```

`GET /health` is public process liveness. `GET /ready`, `GET /metrics`, and `GET /api/admin/model-providers/status` require a global administrator because they expose dependency and operational details. The model-provider status operation performs content-free catalog probes and reports only configured identifiers, capabilities, availability, latency, and sanitized error codes. Audit listing requires workspace access; JSON or NDJSON audit export requires the workspace `ADMIN` role. Audit responses contain only the audit record identifiers, event type, timestamps, and the sanitized metadata already persisted with each event.

The JSON contract is the source for API tooling; no browser documentation UI is bundled. Validate the contract and its coverage of registered Express routes with:

```bash
cd backend
npm run test:openapi
```

The contract is versioned independently when externally observable fields or operations change.

Artifact uploads may provide `previousArtifactId` to create a linear version lineage and `retentionUntil` to prohibit early deletion. `DELETE /api/workspaces/{workspaceId}/artifacts/{artifactId}` requires workspace `ADMIN`, returns `202`, and exposes the durable deletion-job state. Deletion is rejected while retention applies, a nonterminal run references the artifact, extraction is running, or the artifact has an active knowledge source or indexing job. Metadata remains queryable for audit after MinIO objects and any vectors for inactive knowledge sources are removed asynchronously. Repeating the request is safe and requeues a cleanup job that exhausted its prior attempts.

`POST /api/workspaces/{workspaceId}/runs` returns `409 WORKSPACE_RUN_CONCURRENCY_LIMIT_EXCEEDED` when that workspace already has a queued, running, or approval-paused run, and `429 USER_RUN_CONCURRENCY_LIMIT_EXCEEDED` when the requester has reached the configured cross-workspace limit. Accepted runs expose their immutable input/output/total token-budget snapshot in `state.tokenBudget`.

`DELETE /api/knowledge-sources/{sourceId}` requires global `ADMIN` or `ADMIN` membership in the source workspace. PostgreSQL marks the source non-retrievable before returning `202`; durable `REMOVE_SOURCE` jobs delete its points from every linked Qdrant collection and finish the source in `DELETED`. Repeating the request is safe and requeues failed cleanup. `POST /api/admin/knowledge-indexes/rebuild` requires global `ADMIN` and explicitly schedules every active source for rebuild in the current active index.
