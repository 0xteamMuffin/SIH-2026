# SIH-2026 end-to-end guide

SIH-2026 is an internal AI workbench for confidential industrial documents, images, and code. It keeps application records in local PostgreSQL, source/generated files in local MinIO, and future knowledge search in local Qdrant.

## Sovereign and air-gapped

**Sovereign** means the organisation controls its data stores, model endpoint, access rules, logs, and deployment. In sovereign mode this app sends model prompts only to an internal model endpoint.

**Air-gapped** is stricter: the environment has no route to the public internet. It is enforced by network policy, not by a model instruction. `docker-compose.sovereign.yml` removes the backend's development-egress network; core services use an internal Docker network, and code jobs run with `--network none`. A real deployment must also block outbound traffic at the host firewall/network boundary.

Remote development inference is **not sovereign**: public or synthetic task data is sent to the configured endpoint. Remote access is optional and disabled in sovereign mode.

## How a document task works

1. The operator signs in with local credentials and creates a workspace.
2. A source document is uploaded to MinIO. Its metadata is stored in PostgreSQL through Prisma.
3. The operator starts a task. The router classifies it as document, vision, code, or general and records the chosen model profile and routing reason.
4. A durable agent run is created. It records messages, tool calls/results, evidence, artifacts, and audit events in PostgreSQL.
5. The source file is read through the scoped artifact tool. UTF-8 text formats are extracted locally; PDF, image, and Office formats may use the internal CPU-only Docling service for deterministic text, layout, table, and OCR extraction. Vision-routed PNG, JPEG, and WEBP originals are sent as bounded in-memory inputs alongside that text. PDF page rendering is not implemented, so PDF model requests remain extraction-text-only. Canonical extraction results and checksums are retained for reuse.
6. The selected provider analyses the source. Development may allow a configured remote endpoint; sovereign mode permits only internal OpenAI-compatible endpoints.
7. Findings become persisted evidence. The document flow generates an approval-note DOCX with source references, saves it to MinIO, and exposes an authenticated download.

## Code task

Code wording routes a task to the code model profile. The sandbox runner creates a temporary Docker job with a read-only root filesystem, dropped capabilities, CPU/memory/PID limits, a timeout, and no network. Its stdout, stderr, and exit code are saved as a run tool result.

## Start modes

Development (optionally allows a configured remote model endpoint):

```bash
cp .env.example .env
docker compose up --build
```

Sovereign mode (requires an already-running internal model endpoint; Compose intentionally does not pull Ollama):

```bash
docker compose -f docker-compose.yml -f docker-compose.sovereign.yml up --build
```

Configure providers, endpoints, model IDs, capabilities, and routing priorities in `backend/config/models.json`. Provider credentials are referenced by environment-variable name and are never stored in that file.

## Current boundaries

- Qdrant is deployed but knowledge-base ingestion/retrieval is the next module to wire in.
- Docling is an optional deterministic parser rather than the intelligence layer. Worker startup and non-document tasks do not depend on its availability; semantic interpretation of complex visual material uses the selected vision-capable model.
- The current agent persists bounded orchestrated tools; native local-model tool calling is the next harness enhancement.
- Ollama is not included in the active Compose stack so no Ollama image is pulled.
