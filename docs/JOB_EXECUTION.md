# Durable job execution

Agent work uses PostgreSQL as the source of truth and RabbitMQ as the delivery transport. RabbitMQ availability must not determine whether an accepted run record is preserved.

Knowledge jobs use the same outbox delivery guarantees but an isolated exchange, queues, channel, prefetch, and retry policy. A knowledge processor starts this consumer by calling `startKnowledgeWorker(processKnowledgeJob, failKnowledgeJob)`; the agent worker does not consume knowledge jobs.

## Components

- The API creates an `AgentRun` and an outbox event in one PostgreSQL transaction.
- The outbox dispatcher publishes unpublished events through a RabbitMQ confirm channel.
- The worker consumes persistent messages with manual acknowledgements and bounded prefetch.
- The worker claims runs through an atomic PostgreSQL status transition before executing tools.
- Active claims carry a lease ID, heartbeat timestamp, and expiry timestamp.
- The worker's periodic dispatcher republishes pending outbox events after worker or broker recovery.
- Startup and periodic recovery atomically return expired `RUNNING` claims to `PENDING` and create a fresh recovery outbox event.

## Topology

| Resource | Purpose |
| --- | --- |
| `workbench.agent` | Durable direct exchange for agent jobs. |
| `workbench.agent.runs` | Durable primary queue consumed by agent workers. |
| `workbench.agent.retry` | Durable retry queue that returns messages to the primary exchange after a bounded delay. |
| `workbench.agent.dead` | Durable dead-letter queue for exhausted or invalid messages. |
| `workbench.agent.control` | Durable fanout exchange for cancellation commands delivered to every live worker. |
| `workbench.knowledge` | Durable direct exchange for knowledge jobs and retry/dead-letter routing. |
| `workbench.knowledge.jobs` | Durable primary queue consumed by knowledge workers. |
| `workbench.knowledge.retry` | Durable retry queue that returns messages to the knowledge jobs queue after a bounded delay. |
| `workbench.knowledge.dead` | Durable queue for exhausted or invalid knowledge job messages. |

Agent queue names and worker concurrency are configurable. Knowledge transport uses the fixed `workbench.knowledge` names above. Message bodies contain identifiers only; source documents and prompts are loaded from authorized durable storage by the worker.

Knowledge producers persist the `knowledge.job.requested` outbox topic with the strict payload `{ "jobId": "<UUID>" }`. The dispatcher validates that payload and publishes it through confirms to `workbench.knowledge` using the `jobs` routing key. Knowledge retry count, delay, and prefetch are configured independently with `KNOWLEDGE_QUEUE_MAX_RETRIES`, `KNOWLEDGE_QUEUE_RETRY_DELAY_MS`, and `KNOWLEDGE_QUEUE_PREFETCH`.

## Delivery rules

- Messages are persistent and published through confirms.
- Consumers acknowledge only after a terminal database transition or confirmed retry/dead-letter publication.
- Redelivery is expected. Database compare-and-set transitions make processing idempotent.
- Retry attempts are recorded in message headers and bounded by configuration.
- Invalid payloads are dead-lettered without execution.
- Graceful shutdown stops new deliveries and allows active jobs a bounded completion window before their unacknowledged deliveries are returned to RabbitMQ.

## Failure recovery

- If database commit succeeds but initial publication fails, the unpublished outbox event remains available for dispatch.
- If publication succeeds but marking the outbox row fails, republishing is safe because the run claim is idempotent.
- If a worker exits before acknowledgement, RabbitMQ redelivers the message.
- If a worker exits after a tool side effect, tool idempotency keys prevent duplicate effects.
- Workers renew leases while running. An expired or missing lease is recovered with a compare-and-set transition and a new outbox event, so concurrent recovery cycles cannot enqueue the same transition twice.
- Lease IDs fence completion and retry transitions from an obsolete worker attempt.
- Completed tool outputs are replayed without invoking the tool again; generated artifacts also use a deterministic object key to cover interruption between artifact persistence and tool completion persistence.

## Cancellation

Cancellation first performs the `CANCELLED` database transition and creates its outbox event in one transaction. Repeated cancellation returns the existing cancelled run without creating another event. The outbox dispatcher broadcasts the command to every live worker; the worker that owns the active delivery aborts its per-run controller, which propagates through model and sandbox HTTP requests. Heartbeat lease loss provides a fallback abort when a control message is missed, and terminal compare-and-set updates prevent cancelled runs from becoming completed or failed afterward.

Control queues are exclusive and worker-local, so a cancellation broadcast sent while no worker is connected is not retained by RabbitMQ. PostgreSQL remains authoritative: a later delivery cannot claim a cancelled run.

## Security

- RabbitMQ is attached only to the internal application network.
- Applications use a dedicated non-default RabbitMQ account.
- Management UI ports are not published in production-oriented Compose configuration.
- Queue messages never contain secrets, document bytes, extracted text, or model prompts.
- TLS and separately scoped publisher/consumer accounts remain deployment-hardening requirements.
