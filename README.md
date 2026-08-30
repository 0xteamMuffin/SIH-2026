# SIH-2026 — Sovereign Industrial AI Workbench

An on-premise agentic AI workbench for confidential industrial knowledge work.

Read [the end-to-end guide](./docs/END_TO_END.md) for architecture, data flow, and sovereign-mode details.

Backend delivery is tracked in [the backend roadmap](./docs/BACKEND_ROADMAP.md). Deferred UI integration is tracked separately in [the frontend backlog](./docs/FRONTEND_BACKLOG.md).

Inference providers and models are configured through [the vendor-neutral model registry](./docs/MODEL_CONFIGURATION.md).

Optional development providers and API-key locations are listed in [the remote provider setup guide](./docs/REMOTE_PROVIDERS.md).

Durable agent processing is defined in [the RabbitMQ job execution design](./docs/JOB_EXECUTION.md).

OCR, structured extraction, and vision responsibilities are defined in [the hybrid document-understanding design](./docs/DOCUMENT_UNDERSTANDING.md).


## Quick start

1. Copy `.env.example` to `.env` and change all development secrets.
2. Start the development stack: `docker compose up --build`.
3. Open the workbench at `http://localhost:3000` and sign in using the seeded admin credentials from `.env`.

Development can use any configured remote OpenAI-compatible endpoint when `ALLOW_REMOTE_INFERENCE=true`. Remote inference accepts only public or synthetic data and is non-sovereign.

For an air-gapped deployment, start `docker compose -f docker-compose.yml -f docker-compose.sovereign.yml up --build`. The sovereign override disables every remote model profile, removes remote credentials and backend egress, and uses only local profiles from `backend/config/models.json`.

## Included services

- Express API and Next.js workbench
- PostgreSQL for users, workspaces, agent runs, evidence, tool calls, artifacts, and audit events
- MinIO for uploaded and generated files
- Qdrant for local knowledge retrieval
- Isolated Docker sandbox runner for coding tasks
- Provider-neutral local-model endpoint configuration for a future internal model server

The default demo creates a local admin account, supports document uploads, runs a bounded agent harness, records every step, and can generate an approval-note DOCX from grounded findings.
