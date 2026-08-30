# Durable job execution

Agent work uses PostgreSQL as the source of truth and RabbitMQ as the delivery transport. RabbitMQ availability must not determine whether an accepted run record is preserved.

Knowledge jobs use the same outbox delivery guarantees but an isolated exchange, queues, channel, prefetch, and retry policy. The backend worker provisions the active knowledge index before starting both the agent and knowledge consumers, and drains both consumers during graceful shutdown.

## Components

- The API creates an `AgentRun` and an outbox event in one PostgreSQL transaction.
- The outbox dispatcher publishes unpublished events through a RabbitMQ confirm channel.
- The worker consumes persistent messages with manual acknowledgements and bounded prefetch.
- The API serializes admission with a PostgreSQL transaction-scoped advisory lock, then atomically enforces one queued/active run per workspace and `AGENT_MAX_CONCURRENT_RUNS_PER_USER` queued/active runs per requester.
- The worker serializes claims with a separate advisory lock and admits at most `QUEUE_PREFETCH` database `RUNNING` runs globally, including across worker replicas. A capacity miss leaves the run pending and writes a delayed outbox request rather than consuming a retry.
- Each run snapshots its maximum turns, maximum tool calls, input/output/total token budgets, and absolute execution deadline when accepted.
- The worker advances a persisted `SOURCE`/`ANALYZE`/`ACTION`/`FINALIZE` cursor and emits concise progress events, never hidden reasoning or chain-of-thought.
- Active claims carry a lease ID, heartbeat timestamp, and expiry timestamp.
- The worker's periodic dispatcher republishes pending outbox events after worker or broker recovery.
- Startup and periodic recovery atomically return expired `RUNNING` claims to `PENDING` and create a fresh recovery outbox event.
- Knowledge reconciliation also repairs missing or stale source-index rows, validates ready rows against Qdrant point counts and revision payloads, resumes source removal, and deletes only orphan points whose source is absent or terminally inactive in PostgreSQL. Its interval is controlled by `KNOWLEDGE_RECONCILIATION_INTERVAL_MS`.

## Tool approvals

Tools are registered with strict input schemas and risk metadata. `artifact.read` is low risk, `deliverable.createApprovalNote` is medium risk, and `sandbox.execute` is high risk. Current policy requires reviewer approval for every high-risk tool call.

Before sandbox execution, the worker atomically creates a `WAITING_APPROVAL` tool call and approval row containing the exact validated `{ language, code }` input, then changes the run to `WAITING_APPROVAL` and releases its lease. A database trigger makes the approval's run, workspace, tool, risk, and input immutable.

Reviewers decide with `POST /api/agent-approvals/:approvalId/decision` and body `{ "decision": "APPROVED" | "REJECTED", "note"?: "..." }`. Authorization is resolved from the current `workspace_members` row inside the service; only workspace `REVIEWER` and `ADMIN` memberships qualify, regardless of the JWT role claim. The decision uses a pending-status compare-and-set, transitions the waiting run to `PENDING`, and writes `agent.run.resumed` to the outbox in the same transaction. On resume, an approval executes the immutable input once; a rejection is returned to the runtime as a denied tool result.

Run reads include approval records. Source-backed evidence is stored as `SOURCE`, while model-produced content is stored as `MODEL_OUTPUT` and returned under separate result ID lists.

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

`AGENT_MAX_INPUT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, and `AGENT_MAX_TOTAL_TOKENS` are cumulative per-run budgets across provider fallbacks and repair calls. Before every call, the worker sums persisted successful `ModelInvocation` usage and bounds the requested output by the remaining output and total budgets. A response may reach a budget exactly; exhausted budgets stop the next call, while an over-budget response is persisted and then terminally fails the run without queue retry. Providers that omit prompt or completion usage also fail the run closed. When the selected profile has pricing metadata, the invocation stores its pricing version, currency, and estimated integer micro-unit cost. Approval pauses and resumes retain the budget snapshot in `AgentRun.state`.

Knowledge producers persist the `knowledge.job.requested` outbox topic with the strict payload `{ "jobId": "<UUID>" }`. The dispatcher validates that payload and publishes it through confirms to `workbench.knowledge` using the `jobs` routing key. Knowledge retry count, delay, and prefetch are configured independently with `KNOWLEDGE_QUEUE_MAX_RETRIES`, `KNOWLEDGE_QUEUE_RETRY_DELAY_MS`, and `KNOWLEDGE_QUEUE_PREFETCH`.

Knowledge-source deletion uses one durable `REMOVE_SOURCE` job per linked index collection. An active indexing lease is allowed to fence itself out before removal starts, preventing a late upsert from recreating points after deletion. A global administrator can explicitly enqueue `REBUILD_INDEX` for the current active index. Model-version migration is not automatic because safe cutover requires a fully backfilled replacement index before activation.

No reranking model is configured in `backend/config/models.json`, so retrieval currently preserves vector similarity ordering. If an eligible profile is added, authorized retrieval candidates are sent through the bounded reranking boundary before the requested result limit is applied. No profile means no provider call, and sensitive query or candidate text is never routed to a remote reranker.

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

Cancellation first performs the `CANCELLED` database transition and creates its outbox event in one transaction. Pending, running, and `WAITING_APPROVAL` runs can be cancelled; pending approvals and unfinished tool calls are cancelled in the same transaction. Repeated cancellation returns the existing cancelled run without creating another event. The outbox dispatcher broadcasts the command to every live worker; the worker that owns the active delivery aborts its per-run controller, which propagates through model and sandbox HTTP requests. Heartbeat lease loss provides a fallback abort when a control message is missed, and terminal compare-and-set updates prevent cancelled runs from becoming completed or failed afterward.

Control queues are exclusive and worker-local, so a cancellation broadcast sent while no worker is connected is not retained by RabbitMQ. PostgreSQL remains authoritative: a later delivery cannot claim a cancelled run.

## Security

- RabbitMQ is attached only to the internal application network.
- Applications use a dedicated non-default RabbitMQ account.
- Management UI ports are not published in production-oriented Compose configuration.
- Queue messages never contain secrets, document bytes, extracted text, or model prompts.
- TLS and separately scoped publisher/consumer accounts remain deployment-hardening requirements.
