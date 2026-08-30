# Model configuration

The backend treats every inference service as an OpenAI-compatible endpoint. Vendor names do not appear in application logic or environment-variable names.

## Environment variables

Only these settings control model infrastructure:

| Variable | Purpose |
| --- | --- |
| `MODEL_CONFIG_PATH` | Path to the validated provider and model registry. Defaults to `config/models.json` outside Docker and `/app/config/models.json` in Docker. |
| `ALLOW_REMOTE_INFERENCE` | Enables profiles marked `remote`. Must be `false` in sovereign mode. |
| `REMOTE_MODEL_API_KEY` | Credential used by the example remote provider. Additional providers may reference a different environment variable. |
| `MODEL_REQUEST_TIMEOUT_MS` | Maximum duration of one model request. |
| `VISION_MAX_IMAGE_BYTES` | Maximum combined image payload accepted for one vision request. Defaults to 10 MiB and cannot exceed the 25 MiB upload limit. |
| `PDF_RENDERER_URL`, `PDF_RENDERER_API_TOKEN` | Internal authenticated PDF renderer endpoint and shared credential. |
| `PDF_RENDER_TIMEOUT_MS` | End-to-end render deadline; cancellation also terminates the sidecar worker thread. |
| `PDF_RENDER_MAX_SOURCE_BYTES` | Maximum PDF bytes accepted by the adapter and sidecar. |
| `PDF_RENDER_MAX_PAGES`, `PDF_RENDER_DPI` | Maximum selected pages and requested render resolution. |
| `PDF_RENDER_MAX_DOCUMENT_PAGES` | Sidecar-only ceiling for the source document's page count. |
| `PDF_RENDER_MAX_PIXELS_PER_PAGE` | Per-page decoded pixel ceiling; large pages are scaled down. |
| `PDF_RENDER_MAX_TOTAL_BYTES` | Combined PNG response ceiling; cannot exceed `VISION_MAX_IMAGE_BYTES`. |
| `PDF_RENDERER_CONCURRENCY` | Sidecar-only concurrent render-worker limit; excess work fails fast for queue retry. |

Database, storage, authentication, and sandbox variables remain separate because they configure different subsystems.

## Registry structure

`backend/config/models.json` contains two lists:

- `providers` defines an identifier, `local` or `remote` location, OpenAI-compatible base URL, and optional credential environment-variable name.
- `models` defines a stable profile identifier, provider reference, provider-specific model identifier, capabilities, priority, enabled state, and output-token limit.

Lower priority numbers are selected first. Other matching profiles become ordered fallback candidates. Provider-specific model names are configuration values and may be replaced without changing backend code.

The development registry currently assigns separate free profiles for general documents, deeper reasoning, coding, vision, text embeddings, and multimodal embeddings. Free model availability changes over time, so these entries are configuration rather than application constants.

## Embedding profiles

A profile with the `embedding` capability must also define:

| Field | Purpose |
| --- | --- |
| `revision` | Immutable model/weights revision used to identify the vector space. Never reuse a revision after changing weights, preprocessing, dimensions, or distance. |
| `dimensions` | Exact dense-vector length returned by the provider. |
| `distance` | Vector comparison function: `cosine`, `euclid`, `dot`, or `manhattan`. |
| `maxBatchInputs` | Maximum strings sent in one provider request. |
| `maxBatchCharacters` | Maximum combined characters sent in one provider request. |
| `maxInputCharacters` | Maximum characters allowed in one string; it cannot exceed `maxBatchCharacters`. |
| `inputModalities` | Supported inputs, using `TEXT` and/or `IMAGE`. |

The configured character and batch limits are application safety limits and may be lower than provider limits. The current OpenRouter NVIDIA profiles produce 2048-dimensional vectors; Cloudflare BGE-M3 produces 1024-dimensional vectors.

Text embedding selection considers only enabled profiles that declare `TEXT`, applies the data-classification policy, then chooses exactly one profile by ascending priority and profile ID. The selected registry object is compatible with the embedding provider's `EmbeddingProfile` input.

An index is bound to the selected profile's immutable `revision`, `dimensions`, and `distance`. Do not retry or fall back to another embedding profile for writes or queries in that index, even when another profile has the same dimensions. A profile failure must fail the operation; changing vector spaces requires a new index and re-embedding its contents.

## Remote inference

Remote inference requires all of the following:

- `ALLOW_REMOTE_INFERENCE=true`.
- The selected profile belongs to a provider marked `remote`.
- Any environment variable named by `apiKeyEnv` contains a credential.
- Task and source data are classified `PUBLIC` or `SYNTHETIC`.
- The backend has an egress-capable network attachment.

Failure of any check blocks the request before document content is transmitted.

## Sovereign inference

The sovereign Compose override sets `ALLOW_REMOTE_INFERENCE=false`, removes the remote credential, and replaces the backend network list with the internal network. Only profiles attached to providers marked `local` remain eligible.

For the target RTX 4070 with 8 GB VRAM, the example registry uses one small multimodal model for general, document, and vision tasks and a separate quantized coding model. These are defaults only; model identifiers and endpoints can be changed in the registry.

## Adding another provider

1. Add a provider with a unique ID and OpenAI-compatible `baseUrl`.
2. Mark its location as `local` or `remote`.
3. If authentication is required, set `apiKeyEnv` to an environment-variable name and provide that secret at deployment.
4. Add one or more model profiles referencing the provider ID.
5. Assign capabilities and deterministic priorities.
6. Restart the API and workers so configuration is validated before serving traffic.

Secrets must never be written into `models.json`.
