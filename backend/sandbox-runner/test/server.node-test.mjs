import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildDockerArgs, createApp, executeDockerJob, SandboxJobService } from "../server.mjs";

const token = "test-sandbox-token-with-at-least-32-bytes";
const config = {
  token, port: 4100, concurrency: 1, queueLimit: 1, sourceLimitBytes: 1024,
  outputLimitBytes: 1024, timeoutMs: 1_000, retentionMs: 60_000,
};

async function withServer(execute, callback) {
  const service = new SandboxJobService(config, { execute, checkReady: async () => true });
  const server = createApp(config, service).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, service);
  } finally {
    server.close();
    await service.shutdown();
  }
}

function request(url, path, init = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
}

test("job API authenticates, executes asynchronously, and preserves idempotency", async () => {
  await withServer(async (job) => ({ stdout: job.language, stderr: "", exitCode: 0, timedOut: false, outputTruncated: false }), async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    assert.equal((await fetch(`${url}/v1/jobs/missing`)).status, 401);

    const headers = { "idempotency-key": "same-request" };
    const first = await request(url, "/v1/jobs", { method: "POST", headers, body: JSON.stringify({ source: "print('ok')", language: "python" }) });
    assert.equal(first.status, 202);
    const submitted = await first.json();
    const duplicate = await request(url, "/v1/jobs", { method: "POST", headers, body: JSON.stringify({ source: "print('ok')", language: "python" }) });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).id, submitted.id);

    let job;
    do {
      job = await (await request(url, `/v1/jobs/${submitted.id}`)).json();
    } while (["queued", "running"].includes(job.status));
    assert.equal(job.status, "succeeded");
    assert.equal(job.result.stdout, "python");

    const conflict = await request(url, "/v1/jobs", { method: "POST", headers, body: JSON.stringify({ source: "different", language: "python" }) });
    assert.equal(conflict.status, 409);
  });
});

test("queue is bounded and queued jobs can be cancelled", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await withServer(async (_job, signal) => {
    await Promise.race([blocked, new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))]);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, outputTruncated: false };
  }, async (url) => {
    const submit = (key) => request(url, "/v1/jobs", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ source: "", language: "javascript" }) });
    assert.equal((await submit("one")).status, 202);
    const second = await submit("two");
    assert.equal(second.status, 202);
    const secondJob = await second.json();
    assert.equal((await submit("three")).status, 429);
    const cancelled = await request(url, `/v1/jobs/${secondJob.id}/cancel`, { method: "POST" });
    assert.equal((await cancelled.json()).status, "cancelled");
    assert.equal((await submit("three")).status, 202);
    release();
  });
});

test("Docker invocation has fixed runtimes and hardening without mounts", () => {
  for (const [language, expectedCommand] of [["javascript", ["node", "-"]], ["python", ["python", "-I", "-"]]]) {
    const args = buildDockerArgs({ id: "00000000-0000-4000-8000-000000000000", language }, config);
    assert.deepEqual(args.slice(-expectedCommand.length), expectedCommand);
    assert.match(args.at(-(expectedCommand.length + 1)), new RegExp(`^${language === "javascript" ? "node:22-alpine" : "python:3.13-alpine"}@sha256:[a-f0-9]{64}$`));
    assert.equal(args.includes("--pull"), true);
    assert.equal(args[args.indexOf("--pull") + 1], "never");
    assert.equal(args.includes("--network"), true);
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.equal(args.includes("--read-only"), true);
    assert.equal(args.includes("--cap-drop"), true);
    assert.equal(args.includes("--user"), true);
    assert.equal(args.some((arg) => ["-v", "--volume", "--mount"].includes(arg)), false);
  }
});

test("container execution streams source and bounds combined output", async () => {
  let input = "";
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  child.stdin.on("data", (chunk) => { input += chunk; });
  const spawnProcess = () => {
    queueMicrotask(() => {
      child.stdout.write("12345678");
      child.stderr.write("abcdefgh");
      child.emit("close", 137);
    });
    return child;
  };
  const result = await executeDockerJob(
    { id: "00000000-0000-4000-8000-000000000000", language: "javascript", source: "console.log('stdin')" },
    new AbortController().signal,
    { ...config, outputLimitBytes: 10 },
    spawnProcess,
    async () => {},
  );
  assert.equal(input, "console.log('stdin')");
  assert.equal(Buffer.byteLength(result.stdout + result.stderr), 10);
  assert.equal(result.outputTruncated, true);
  assert.equal(killed, true);
});
