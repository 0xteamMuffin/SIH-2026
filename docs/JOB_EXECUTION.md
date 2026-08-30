# Durable job execution

Agent work uses PostgreSQL as the source of truth and RabbitMQ as the delivery transport. RabbitMQ availability must not determine whether an accepted run record is preserved.

## Components

- The API creates an `AgentRun` and an outbox event in one PostgreSQL transaction.
- The outbox dispatcher publishes unpublished events through a RabbitMQ confirm channel.
- The worker consumes persistent messages with manual acknowledgements and bounded prefetch.
- The worker claims runs through an atomic PostgreSQL status transition before executing tools.
- The worker's periodic dispatcher republishes pending outbox events after worker or broker recovery.

## Topology

| Resource | Purpose |
| --- | --- |
| `workbench.agent` | Durable direct exchange for agent jobs. |
| `workbench.agent.runs` | Durable primary queue consumed by agent workers. |
| `workbench.agent.retry` | Durable retry queue that returns messages to the primary exchange after a bounded delay. |
| `workbench.agent.dead` | Durable dead-letter queue for exhausted or invalid messages. |

Queue names and worker concurrency are configurable. Message bodies contain identifiers only; source documents and prompts are loaded from authorized durable storage by the worker.

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
- Stale `RUNNING` runs are recovered according to their heartbeat and retry policy.

## Cancellation

Cancellation first performs an atomic database transition. Workers use an `AbortController` per active run and check cancellation between tool steps. The API publishes a cancellation command so the owning worker can abort model and sandbox requests promptly. Terminal compare-and-set updates prevent cancelled runs from becoming completed or failed afterward.

## Security

- RabbitMQ is attached only to the internal application network.
- Applications use a dedicated non-default RabbitMQ account.
- Management UI ports are not published in production-oriented Compose configuration.
- Queue messages never contain secrets, document bytes, extracted text, or model prompts.
- TLS and separately scoped publisher/consumer accounts remain deployment-hardening requirements.
