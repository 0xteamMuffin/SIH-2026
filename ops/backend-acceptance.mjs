import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendRoot = process.env.ACCEPTANCE_BACKEND_ROOT ?? path.join(root, "backend");
const fixtureRoot = process.env.ACCEPTANCE_FIXTURE_ROOT ?? path.join(backendRoot, "test", "fixtures");
const apiUrl = (process.env.ACCEPTANCE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const sandboxUrl = (process.env.ACCEPTANCE_SANDBOX_URL ?? "http://localhost:4100").replace(/\/$/, "");
const sandboxToken = process.env.ACCEPTANCE_SANDBOX_TOKEN ?? "change-me-to-a-long-random-sandbox-token";
const amqpUrl = process.env.ACCEPTANCE_AMQP_URL ?? "amqp://sih:change-me-rabbitmq@localhost:5672";
const adminEmail = process.env.ACCEPTANCE_ADMIN_EMAIL ?? "admin@sih.local";
const adminPassword = process.env.ACCEPTANCE_ADMIN_PASSWORD ?? "ChangeMe123!";
const expectSovereign = process.env.ACCEPTANCE_EXPECT_SOVEREIGN !== "false";
const runLiveProvider = process.env.ACCEPTANCE_LIVE_PROVIDER === "true";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fixture = (name) => path.join(fixtureRoot, name);

async function http(baseUrl, pathname, { token, expected = 200, ...options } = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.body && typeof options.body !== "string" && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(allowed.includes(response.status), `${options.method ?? "GET"} ${pathname}: expected ${allowed.join("/")}, received ${response.status}: ${text}`);
  return { response, body };
}

async function waitFor(description, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last?.done) return last.value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
}

async function verifyRabbitMq() {
  const requireFromBackend = createRequire(path.join(backendRoot, "package.json"));
  const { connect } = requireFromBackend("amqplib");
  const connection = await connect(amqpUrl);
  try {
    const channel = await connection.createChannel();
    const queue = await channel.assertQueue("", { exclusive: true, autoDelete: true });
    const payload = Buffer.from(`acceptance-${crypto.randomUUID()}`);
    channel.sendToQueue(queue.queue, payload, { contentType: "text/plain", persistent: false });
    const message = await waitFor("RabbitMQ message delivery", async () => {
      const received = await channel.get(queue.queue, { noAck: true });
      return received ? { done: true, value: received } : { done: false };
    }, 10_000);
    assert.equal(message.content.toString(), payload.toString());
    await channel.close();
  } finally {
    await connection.close();
  }
}

async function verifySandbox() {
  await http(sandboxUrl, "/health");
  await http(sandboxUrl, "/v1/jobs", { method: "POST", expected: 401, body: { language: "javascript", source: "" } });
  const submitted = await http(sandboxUrl, "/v1/jobs", {
    method: "POST",
    expected: 202,
    headers: { "idempotency-key": `acceptance-${crypto.randomUUID()}` },
    token: sandboxToken,
    body: { language: "javascript", source: "console.log('sandbox-acceptance')" },
  });
  const result = await waitFor("sandbox completion", async () => {
    const current = await http(sandboxUrl, `/v1/jobs/${submitted.body.id}`, { token: sandboxToken });
    return ["succeeded", "failed", "cancelled"].includes(current.body.status)
      ? { done: true, value: current.body }
      : { done: false, value: current.body.status };
  }, 30_000);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.match(result.result.stdout, /sandbox-acceptance/);
}

async function main() {
  const health = await http(apiUrl, "/health");
  assert.equal(health.body.status, "ok");
  if (expectSovereign) assert.equal(health.body.sovereign, true, "Acceptance stack must report sovereign mode");

  await http(apiUrl, "/api/auth/me", { expected: 401 });
  const login = await http(apiUrl, "/api/auth/login", {
    method: "POST",
    body: { email: adminEmail, password: adminPassword },
  });
  const adminToken = login.body.accessToken;
  assert(adminToken);
  const ready = await http(apiUrl, "/ready", { token: adminToken });
  assert.equal(ready.body.dependencies.qdrant, "ready");
  const me = await http(apiUrl, "/api/auth/me", { token: adminToken });
  assert.equal(me.body.user.email, adminEmail);

  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const adminWorkspace = await http(apiUrl, "/api/workspaces", {
    method: "POST", expected: 201, token: adminToken, body: { name: `Acceptance ${suffix}` },
  });
  const workspaceId = adminWorkspace.body.workspace.id;

  const operatorEmail = `acceptance-${suffix}@example.test`;
  const operatorPassword = `Acceptance-${suffix}!`;
  const createdOperator = await http(apiUrl, "/api/auth/users", {
    method: "POST", expected: 201, token: adminToken,
    body: { email: operatorEmail, password: operatorPassword, role: "OPERATOR" },
  });
  const operatorLogin = await http(apiUrl, "/api/auth/login", {
    method: "POST", body: { email: operatorEmail, password: operatorPassword },
  });
  const operatorToken = operatorLogin.body.accessToken;
  const operatorWorkspace = await http(apiUrl, "/api/workspaces", {
    method: "POST", expected: 201, token: operatorToken, body: { name: `Isolated ${suffix}` },
  });
  assert.notEqual(operatorWorkspace.body.workspace.id, workspaceId);
  assert.equal(createdOperator.body.user.role, "OPERATOR");

  await http(apiUrl, `/api/workspaces/${workspaceId}/artifacts`, { token: operatorToken, expected: 403 });
  await http(apiUrl, `/api/workspaces/${workspaceId}/knowledge-sources`, { token: operatorToken, expected: 403 });

  const textBytes = await readFile(fixture("synthetic-maintenance-note.txt"));
  const textForm = new FormData();
  textForm.set("classification", "SYNTHETIC");
  textForm.set("file", new Blob([textBytes], { type: "text/plain" }), "synthetic-maintenance-note.txt");
  const uploadedText = await http(apiUrl, `/api/workspaces/${workspaceId}/artifacts`, {
    method: "POST", expected: 201, token: adminToken, body: textForm,
  });
  const artifactId = uploadedText.body.artifact.id;

  const imageBytes = Buffer.from((await readFile(fixture("synthetic-inspection.png.base64"), "utf8")).trim(), "base64");
  const imageForm = new FormData();
  imageForm.set("classification", "SYNTHETIC");
  imageForm.set("file", new Blob([imageBytes], { type: "image/png" }), "synthetic-inspection.png");
  await http(apiUrl, `/api/workspaces/${workspaceId}/artifacts`, {
    method: "POST", expected: 201, token: adminToken, body: imageForm,
  });

  const mismatchForm = new FormData();
  mismatchForm.set("classification", "SYNTHETIC");
  mismatchForm.set("file", new Blob([imageBytes], { type: "application/pdf" }), "synthetic-inspection.pdf");
  const mismatch = await http(apiUrl, `/api/workspaces/${workspaceId}/artifacts`, {
    method: "POST", expected: 415, token: adminToken, body: mismatchForm,
  });
  assert.equal(mismatch.body.error.code, "FILE_TYPE_MISMATCH");
  await http(apiUrl, `/api/artifacts/${artifactId}`, { token: operatorToken, expected: 404 });

  const sourceRun = await http(apiUrl, `/api/workspaces/${workspaceId}/runs`, {
    method: "POST", expected: 202, token: adminToken,
    body: { task: "Summarize the synthetic maintenance note for testing", artifactId, dataClassification: "INTERNAL" },
  });
  assert.match(sourceRun.body.run.modelProfile, /^local-/, "Restricted data must not route to a remote profile");
  await waitFor("local text extraction", async () => {
    const artifact = await http(apiUrl, `/api/artifacts/${artifactId}`, { token: adminToken });
    assert.notEqual(artifact.body.artifact.extractionStatus, "FAILED", JSON.stringify(artifact.body));
    return artifact.body.artifact.extractionStatus === "COMPLETED"
      ? { done: true, value: artifact.body.artifact }
      : { done: false, value: artifact.body.artifact.extractionStatus };
  });
  await http(apiUrl, `/api/runs/${sourceRun.body.run.id}/cancel`, { method: "POST", token: adminToken, expected: [200, 409] });

  const knowledgeSource = await waitFor("active RAG index", async () => {
    const result = await http(apiUrl, `/api/workspaces/${workspaceId}/knowledge-sources`, {
      method: "POST", expected: [202, 503], token: adminToken, body: { artifactId },
    });
    return result.response.status === 202 ? { done: true, value: result.body } : { done: false, value: result.body.error?.code };
  });
  assert.equal(knowledgeSource.job.status, "QUEUED");
  await http(apiUrl, `/api/knowledge-sources/${knowledgeSource.knowledgeSource.id}`, { token: operatorToken, expected: 404 });

  const query = await http(apiUrl, `/api/workspaces/${workspaceId}/knowledge-queries`, {
    method: "POST", expected: 202, token: adminToken,
    body: { queryText: "What is the invented vibration reading?", dataClassification: "INTERNAL", filters: { artifactIds: [artifactId] } },
  });
  await http(apiUrl, `/api/knowledge-queries/${query.body.knowledgeQuery.id}`, { token: adminToken });
  await http(apiUrl, `/api/knowledge-queries/${query.body.knowledgeQuery.id}`, { token: operatorToken, expected: 404 });

  const cancellable = await http(apiUrl, `/api/workspaces/${workspaceId}/runs`, {
    method: "POST", expected: 202, token: adminToken,
    body: { task: "Return a synthetic response used to verify cancellation", dataClassification: "INTERNAL" },
  });
  const runId = cancellable.body.run.id;
  const firstCancellation = await http(apiUrl, `/api/runs/${runId}/cancel`, { method: "POST", token: adminToken });
  assert.equal(firstCancellation.body.run.status, "CANCELLED");
  const repeatedCancellation = await http(apiUrl, `/api/runs/${runId}/cancel`, { method: "POST", token: adminToken });
  assert.equal(repeatedCancellation.body.run.status, "CANCELLED");
  await sleep(1_000);
  const terminal = await http(apiUrl, `/api/runs/${runId}`, { token: adminToken });
  assert.equal(terminal.body.run.status, "CANCELLED", "A late worker must not overwrite cancellation");
  await http(apiUrl, `/api/runs/${runId}`, { token: operatorToken, expected: 404 });
  await http(apiUrl, `/api/agent-approvals/${crypto.randomUUID()}/decision`, {
    method: "POST", expected: 404, token: operatorToken, body: { decision: "APPROVED" },
  });

  await verifyRabbitMq();
  await verifySandbox();

  if (runLiveProvider) {
    const live = await http(apiUrl, `/api/workspaces/${workspaceId}/runs`, {
      method: "POST", expected: 202, token: adminToken,
      body: { task: "Reply with the exact text LIVE_PROVIDER_OK", dataClassification: "PUBLIC" },
    });
    const finished = await waitFor("live provider run", async () => {
      const current = await http(apiUrl, `/api/runs/${live.body.run.id}`, { token: adminToken });
      return ["COMPLETED", "FAILED", "CANCELLED"].includes(current.body.run.status)
        ? { done: true, value: current.body.run }
        : { done: false, value: current.body.run.status };
    }, 180_000);
    assert.equal(finished.status, "COMPLETED", JSON.stringify(finished));
  }

  console.log("Backend acceptance passed: health/auth/workspaces/uploads/runs/RabbitMQ/RAG/sandbox and security boundaries verified.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
