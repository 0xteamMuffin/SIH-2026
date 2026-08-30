# Backend acceptance and security verification

The verification harness uses synthetic fixtures and does not require an external API or provider credential.

## Deterministic checks

From the repository root:

```bash
node ops/verify-sovereign-compose.mjs
cd backend
npm run test:security
```

The Compose verifier renders both Compose files before checking them. It fails if the backend or worker has a non-internal network or host gateway, if remote-provider credential variables survive rendering, or if an internal service publishes a host port.

To validate every migration against a new disposable PostgreSQL database:

```bash
MIGRATION_TEST_DATABASE_URL=postgresql://test:test@localhost:5432/sih_migration_test npm run test:migrations
```

The target schema must be empty. The script refuses a populated schema, deploys all migrations, runs Prisma's status check, and compares the migration ledger with the migration directories.

## Black-box acceptance

`ops/backend-acceptance.mjs` exercises health, local authentication, workspace isolation, text and image uploads, upload mismatch rejection, run creation and terminal cancellation, approval non-disclosure, knowledge-source/query APIs, RabbitMQ delivery, and the authenticated sandbox API. It expects an already running disposable stack:

```bash
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.sovereign.yml -f ops/docker-compose.acceptance.yml up --build --wait postgres minio minio-init qdrant rabbitmq sandbox-runner backend worker
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.sovereign.yml -f ops/docker-compose.acceptance.yml run --build --rm acceptance
```

The acceptance runner joins only the internal Docker network; it does not publish internal services or add egress. The overlay is test-only because it mounts the test script and fixtures. Tear the disposable stack down with the same file arguments and `down --volumes`.

Environment overrides are `ACCEPTANCE_API_URL`, `ACCEPTANCE_AMQP_URL`, `ACCEPTANCE_SANDBOX_URL`, `ACCEPTANCE_SANDBOX_TOKEN`, `ACCEPTANCE_ADMIN_EMAIL`, and `ACCEPTANCE_ADMIN_PASSWORD`.

## Optional live provider

Set `ACCEPTANCE_LIVE_PROVIDER=true` only in a development stack with a configured remote provider. The harness submits a `PUBLIC` synthetic prompt and requires the run to complete. This check is deliberately excluded from GitHub Actions and must never use restricted data.
