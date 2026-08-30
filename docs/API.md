# Backend API contract

The backend serves its OpenAPI contract at `GET /openapi.json`. The document uses OpenAPI 3.1.0 and carries the independently versioned API contract version in `info.version`.

The contract covers health and authenticated operational readiness/metrics, authentication sessions, user administration, workspace membership, workspace audit events, artifacts, agent runs, tool approvals, knowledge sources, and knowledge queries. Protected operations use the JWT bearer token returned by `POST /api/auth/login`:

```text
Authorization: Bearer <token>
```

`GET /health` is public process liveness. `GET /ready` and `GET /metrics` require a global administrator because they expose dependency and operational details. Audit listing requires workspace access; JSON or NDJSON audit export requires the workspace `ADMIN` role. Audit responses contain only the audit record identifiers, event type, timestamps, and the sanitized metadata already persisted with each event.

The JSON contract is the source for API tooling; no browser documentation UI is bundled. Validate the contract and its coverage of registered Express routes with:

```bash
cd backend
npm run test:openapi
```

The contract version currently follows the backend package version. Increment it when making an externally observable API contract change.

Artifact uploads may provide `previousArtifactId` to create a linear version lineage and `retentionUntil` to prohibit early deletion. `DELETE /api/workspaces/{workspaceId}/artifacts/{artifactId}` requires workspace `ADMIN`, returns `202`, and exposes the durable deletion-job state. Deletion is rejected while retention applies, a nonterminal run references the artifact, extraction is running, or the artifact has an active knowledge source or indexing job. Metadata remains queryable for audit after MinIO objects and any vectors for inactive knowledge sources are removed asynchronously. Repeating the request is safe and requeues a cleanup job that exhausted its prior attempts.
