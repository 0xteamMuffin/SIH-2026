# SIH-2026 — Sovereign Industrial AI Workbench

An on-premise agentic AI workbench for confidential industrial knowledge work.

Read [the end-to-end guide](./docs/END_TO_END.md) for architecture, data flow, and sovereign-mode details.

Backend delivery is tracked in [the backend roadmap](./docs/BACKEND_ROADMAP.md). Deferred UI integration is tracked separately in [the frontend backlog](./docs/FRONTEND_BACKLOG.md).


## Quick start

1. Copy `.env.example` to `.env` and change all development secrets.
2. Start the development stack: `docker compose up --build`.
3. Open the workbench at `http://localhost:3000` and sign in using the seeded admin credentials from `.env`.

`development` uses OpenRouter only when `OPENROUTER_API_KEY` is configured. It is deliberately labelled non-sovereign in the UI and audit stream.

For an air-gapped deployment, start `docker compose -f docker-compose.yml -f docker-compose.sovereign.yml up --build`, set `MODEL_PROVIDER=local`, and point `LOCAL_MODEL_BASE_URL` at an internal OpenAI-compatible model server. The sovereign override removes the development egress network and uses only the internal application network.

## Included services

- Express API and Next.js workbench
- PostgreSQL for users, workspaces, agent runs, evidence, tool calls, artifacts, and audit events
- MinIO for uploaded and generated files
- Qdrant for local knowledge retrieval
- Isolated Docker sandbox runner for coding tasks
- Provider-neutral local-model endpoint configuration for a future internal model server

The default demo creates a local admin account, supports document uploads, runs a bounded agent harness, records every step, and can generate an approval-note DOCX from grounded findings.
