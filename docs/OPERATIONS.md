# Operations and recovery

This runbook covers the Compose deployment. Run recovery exercises on an isolated host and a fresh Compose project before relying on a backup. Never test a restore over the only copy of production data.

## Version and image policy

Service images and Dockerfile bases are pinned to release tags and registry digests. Update a tag and digest together after testing; never copy a digest from an unrelated tag or architecture. `docker compose pull` and `docker compose build --pull` should run only on the connected staging host used to prepare a release.

The sandbox also requires its execution images, which are deliberately pulled with `--pull never` at runtime:

```text
node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d
```

## Backup boundary

A recoverable set needs PostgreSQL, MinIO objects, Qdrant collection snapshots, RabbitMQ definitions, the deployed Compose files, `.env` or equivalent secrets, and model configuration. Store secrets separately from data, encrypt both at rest, and restrict the RabbitMQ export because it contains credential hashes.

The commands below are intentionally manual. Set a destination outside the repository, for example:

```bash
umask 077
export BACKUP=/secure-backups/sih-2026/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP"/{minio,qdrant}
```

Quiesce writers before capturing any data:

```bash
docker compose stop frontend backend worker sandbox-runner
docker compose exec -T rabbitmq rabbitmqctl list_queues --formatter json name messages_ready messages_unacknowledged
```

Wait for `messages_unacknowledged` to reach zero. Decide whether queued jobs must finish, be cancelled, or be reconstructed from PostgreSQL before continuing. Keep the four data services running while taking these logical backups. Prevent external API and AMQP clients from writing for the entire backup window.

### PostgreSQL backup

`pg_dump` produces a transactionally consistent logical dump without destructive flags:

```bash
docker compose exec -T postgres sh -ec \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl' \
  > "$BACKUP/postgres.dump"
test -s "$BACKUP/postgres.dump"
```

### MinIO backup

The application uses one bucket and does not enable object versioning. This mirrors current object data and metadata; the `minio-init` service recreates the private bucket policy.

```bash
docker compose run --rm --no-deps \
  --volume "$BACKUP/minio:/backup" \
  --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc mirror --overwrite --preserve "local/$MINIO_BUCKET" "/backup/$MINIO_BUCKET"
  '
```

If versioning or retention is enabled later, replace this procedure with a tested `mc replicate` or version-aware backup process.

### Qdrant backup

The helper creates one consistent snapshot per collection, downloads it, records its checksum, and deletes only the temporary server-side snapshot. It refuses to reuse a directory that already has a manifest and does not delete collections or points.

```bash
docker compose run --rm --no-deps --user 0:0 \
  --volume "$PWD/ops:/ops:ro" \
  --volume "$BACKUP/qdrant:/backup" \
  backend node /ops/qdrant-snapshot.mjs backup /backup
test -s "$BACKUP/qdrant/manifest.json"
```

### RabbitMQ backup

Export topology, policies, virtual hosts, users, and permissions:

```bash
docker compose exec -T rabbitmq rabbitmqctl export_definitions /tmp/definitions.json
docker compose cp rabbitmq:/tmp/definitions.json "$BACKUP/rabbitmq-definitions.json"
docker compose exec -T rabbitmq rm -f /tmp/definitions.json
test -s "$BACKUP/rabbitmq-definitions.json"
```

RabbitMQ definitions do not contain queued messages. Drain the queues before backup or document which durable jobs will be reconciled from PostgreSQL after recovery. A raw RabbitMQ volume copy is not a portable backup unless node names, Erlang cookies, image versions, and shutdown consistency are all controlled and tested.

### Seal and resume

Copy the exact deployment inputs, then checksum every backup payload. Do not include `SHA256SUMS` in its own input list.

```bash
cp docker-compose.yml docker-compose.sovereign.yml "$BACKUP/"
cp -R backend/config "$BACKUP/backend-config"
(cd "$BACKUP" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
(cd "$BACKUP" && sha256sum -c SHA256SUMS)
docker compose start rabbitmq qdrant minio postgres sandbox-runner worker backend frontend
```

Store `.env` or its secret-manager export separately under the same recovery identifier; do not place plaintext secrets in the data backup. Record the backup path, deployment revision, start/end time, queue state, file count, checksum result, and operator identity. Copy the sealed set to separate failure domains according to the retention policy.

## Restore into an empty target

Use an isolated network and a distinct Compose project. Restore only after `sha256sum -c SHA256SUMS` succeeds. The examples assume the separately protected environment configuration has been reviewed and installed as the target `.env`.

Start only stateful dependencies:

```bash
docker compose up -d postgres minio qdrant rabbitmq
docker compose ps
```

### PostgreSQL restore

Confirm the target database has no application tables. The restore command has no `--clean` or database-drop option and fails on conflicts:

```bash
docker compose exec -T postgres sh -ec \
  'test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from information_schema.tables where table_schema = '\''public'\''")" = 0'
cat "$BACKUP/postgres.dump" | docker compose exec -T postgres sh -ec \
  'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --single-transaction --no-owner --no-acl'
```

### MinIO restore

Create the configured bucket, verify it is empty, and then mirror the backup:

```bash
docker compose run --rm --no-deps minio-init
docker compose run --rm --no-deps \
  --volume "$BACKUP/minio:/backup:ro" \
  --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    test -z "$(mc ls --recursive "local/$MINIO_BUCKET")"
    mc mirror --overwrite --preserve "/backup/$MINIO_BUCKET" "local/$MINIO_BUCKET"
  '
```

### Qdrant restore

The helper verifies every downloaded snapshot, refuses a target containing any collection, and requires an explicit confirmation value. If a restore fails after creating a collection, discard that target and retry with another empty target.

```bash
docker compose run --rm --no-deps --user 0:0 \
  --environment RESTORE_CONFIRM=empty-qdrant-target \
  --volume "$PWD/ops:/ops:ro" \
  --volume "$BACKUP/qdrant:/backup:ro" \
  backend node /ops/qdrant-snapshot.mjs restore /backup
```

### RabbitMQ restore

Import definitions only into the fresh broker, before workers connect:

```bash
docker compose cp "$BACKUP/rabbitmq-definitions.json" rabbitmq:/tmp/definitions.json
docker compose exec -T rabbitmq rabbitmqctl import_definitions /tmp/definitions.json
docker compose exec -T rabbitmq rm -f /tmp/definitions.json
```

### Recovery validation

Apply any newer migrations, start the application, and validate health before enabling ingress:

```bash
docker compose run --rm --no-deps backend npx --no-install prisma migrate deploy
docker compose up -d sandbox-runner worker backend frontend
docker compose ps
docker compose exec -T postgres sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from \"_prisma_migrations\""'
docker compose exec -T rabbitmq rabbitmq-diagnostics -q ping
```

Also verify representative object downloads, Qdrant collection/point counts, authentication, one read-only API path, and one synthetic end-to-end job. Keep the original environment unavailable for writes until the recovery owner approves cutover.

## Offline image bundle

Prepare the bundle on a connected Linux host with the same target architecture. Build first so Compose-generated application image names exist:

```bash
docker compose --env-file .env build --pull
mapfile -t images < <(docker compose --env-file .env config --images | sort -u)
images+=(
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
  "python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d"
)
docker image inspect "${images[@]}" >/dev/null
docker image save --output sih-2026-images.tar "${images[@]}"
sha256sum sih-2026-images.tar > sih-2026-images.tar.sha256
sha256sum docker-compose.yml docker-compose.sovereign.yml .env.example \
  backend/package-lock.json backend/sandbox-runner/package-lock.json frontend/package-lock.json \
  > sih-2026-deployment.sha256
```

Transfer the tar, both checksum files, deployment files, application source needed by the Compose build metadata, and the protected production configuration through the approved media process. On the offline target:

```bash
sha256sum -c sih-2026-images.tar.sha256
sha256sum -c sih-2026-deployment.sha256
docker image load --input sih-2026-images.tar
docker compose --env-file .env config --images | while IFS= read -r image; do docker image inspect "$image" >/dev/null; done
docker image inspect \
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32" \
  "python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d" >/dev/null
docker compose --env-file .env -f docker-compose.yml -f docker-compose.sovereign.yml config --quiet
docker compose --env-file .env -f docker-compose.yml -f docker-compose.sovereign.yml up -d --no-build --pull never
```

Keep the source image tar immutable. Generate a new signed release artifact rather than modifying an existing bundle in place.
