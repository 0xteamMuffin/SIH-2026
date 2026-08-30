# Backend API contract

The backend serves its OpenAPI contract at `GET /openapi.json`. The document uses OpenAPI 3.1.0 and carries the independently versioned API contract version in `info.version`.

The contract covers health and readiness checks, authentication sessions, user administration, workspace membership, artifacts, agent runs, tool approvals, knowledge sources, and knowledge queries. Protected operations use the JWT bearer token returned by `POST /api/auth/login`:

```text
Authorization: Bearer <token>
```

The JSON contract is the source for API tooling; no browser documentation UI is bundled. Validate the contract and its coverage of registered Express routes with:

```bash
cd backend
npm run test:openapi
```

The contract version currently follows the backend package version. Increment it when making an externally observable API contract change.
