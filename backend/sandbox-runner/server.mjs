import express from "express";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import crypto from "node:crypto";
const exec = promisify(execFile), app = express(); app.use(express.json({ limit: "1mb" }));
app.post("/execute", async (req, res) => {
  const id = crypto.randomUUID(), dir = `/workspaces/${id}`; await mkdir(dir, { recursive: true });
  try {
    await writeFile(`${dir}/main.js`, String(req.body.code ?? ""));
    const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "-v", `${dir}:/workspace:ro`, "-w", "/workspace", process.env.SANDBOX_IMAGE ?? "node:22-alpine", "node", "main.js"];
    const { stdout, stderr } = await exec("docker", args, { timeout: Number(process.env.SANDBOX_TIMEOUT_MS ?? 30000) });
    res.json({ stdout, stderr, exitCode: 0 });
  }
  catch (error) { res.json({ stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message), exitCode: error.code ?? 1 }); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
app.listen(4100);
