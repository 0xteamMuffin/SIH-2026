# Sandbox runner

The base Compose file supplies a development-only token when `SANDBOX_API_TOKEN` is absent. Replace it with at least 32 random bytes before any shared, production, or sovereign deployment.

The runner accepts authenticated asynchronous JavaScript and Python jobs. Source is sent to a fixed interpreter over container stdin; it is never bind-mounted. Runtime images must be provisioned on the Docker host in advance because job execution always uses `--pull never`. Readiness remains false until both images exist:

```text
node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d
```

Set a unique `SANDBOX_API_TOKEN` of at least 32 bytes. The runner cleans up containers carrying its managed label when it starts.

## Assurance boundary

The Docker socket gives the runner control of the Docker daemon. Docker Desktop additionally runs containers inside its development VM and is lower assurance than a dedicated, hardened Linux sandbox host. The Compose setup is suitable for local development, not a claim of hostile multi-tenant isolation. Production should use a dedicated host/daemon, pinned and preloaded image digests, host-level monitoring, and an isolation runtime appropriate to the threat model.
