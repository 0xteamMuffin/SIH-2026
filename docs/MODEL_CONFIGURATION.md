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
| `VISION_MAX_IMAGE_BYTES` | Maximum original-image payload accepted for one vision request. Defaults to 10 MiB and cannot exceed the 25 MiB upload limit. |

Database, storage, authentication, and sandbox variables remain separate because they configure different subsystems.

## Registry structure

`backend/config/models.json` contains two lists:

- `providers` defines an identifier, `local` or `remote` location, OpenAI-compatible base URL, and optional credential environment-variable name.
- `models` defines a stable profile identifier, provider reference, provider-specific model identifier, capabilities, priority, enabled state, and output-token limit.

Lower priority numbers are selected first. Other matching profiles become ordered fallback candidates. Provider-specific model names are configuration values and may be replaced without changing backend code.

The development registry currently assigns separate free profiles for general documents, deeper reasoning, coding, vision, text embeddings, and multimodal embeddings. Free model availability changes over time, so these entries are configuration rather than application constants.

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
