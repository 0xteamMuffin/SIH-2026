/**
 * Drives real runs against a live model and reports whether the model actually
 * authored each deliverable, or whether the run fell back to the minimal
 * template.
 *
 * Unit tests can only prove the authoring path handles a well-formed response.
 * Whether a given model reliably produces one — a valid table with typed
 * cells, a formula that passes the allowlist — is a property of the model, and
 * the only way to know is to ask it.
 *
 * Runs inside the compose network, since no backend port is host-published.
 */
import assert from "node:assert/strict";

const apiUrl = (process.env.ACCEPTANCE_API_URL ?? "http://backend:4000").replace(/\/$/, "");
const adminEmail = process.env.ACCEPTANCE_ADMIN_EMAIL ?? "admin@sih.local";
const adminPassword = process.env.ACCEPTANCE_ADMIN_PASSWORD ?? "ChangeMe123!";
const classification = process.env.DELIVERABLE_CLASSIFICATION ?? "SYNTHETIC";
const runTimeoutMs = Number(process.env.DELIVERABLE_RUN_TIMEOUT_MS ?? 240_000);

const SOURCE_DOCUMENT = `# Pipeline Integrity Inspection - Unit 4 Overhead Vapour Line

Report reference: QA-2291. Survey date: 12 January 2026.

Nominal wall thickness is 9.53 mm. Corrosion allowance is 3.00 mm, giving a
retirement thickness of 6.53 mm. The alert threshold is 7.00 mm.

Ultrasonic wall-thickness readings by station, compared with the 2021 baseline:

Station 40: 2021 reading 9.41 mm, 2026 reading 8.02 mm.
Station 41: 2021 reading 9.38 mm, 2026 reading 6.81 mm.
Station 42: 2021 reading 9.44 mm, 2026 reading 7.12 mm.
Station 43: 2021 reading 9.40 mm, 2026 reading 7.35 mm.
Station 44: 2021 reading 9.46 mm, 2026 reading 7.58 mm.
Station 45: 2021 reading 9.39 mm, 2026 reading 7.81 mm.
Station 46: 2021 reading 9.42 mm, 2026 reading 8.19 mm.

Station 41 is the lowest reading on the run and sits below the alert threshold
but above the retirement thickness. Stations 42 to 46 sit immediately
downstream of an elbow and show a consistent thinning trend attributed to
erosion-corrosion. External coating is degraded over a 4 metre section near the
pipe support at station 44, with surface rust but no measurable section loss.

No through-wall defects, blistering, or weld cracking were identified.
`;

async function http(pathname, { token, expected = 200, ...options } = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.body && typeof options.body !== "string" && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${apiUrl}${pathname}`, { ...options, headers });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(allowed.includes(response.status), `${options.method ?? "GET"} ${pathname}: expected ${allowed.join("/")}, got ${response.status}: ${text}`);
  return body;
}

async function waitForRun(runId, token) {
  const deadline = Date.now() + runTimeoutMs;
  while (Date.now() < deadline) {
    const { run } = await http(`/api/runs/${runId}`, { token });
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Run ${runId} did not finish within ${runTimeoutMs} ms`);
}

let failures = 0;
function check(label, passed, detail = "") {
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!passed) failures += 1;
}

async function main() {
  const { token } = await http("/api/auth/login", {
    method: "POST",
    body: { email: adminEmail, password: adminPassword },
  });

  const { workspace } = await http("/api/workspaces", {
    method: "POST",
    expected: [200, 201],
    token,
    body: { name: `deliverable-check-${Date.now()}` },
  });

  const form = new FormData();
  form.set("classification", classification);
  form.set("file", new Blob([SOURCE_DOCUMENT], { type: "text/plain" }), "inspection-report.txt");
  const uploaded = await http(`/api/workspaces/${workspace.id}/artifacts`, {
    method: "POST",
    expected: 201,
    token,
    body: form,
  });
  const artifactId = uploaded.artifact.id;
  console.log(`\nWorkspace ${workspace.id}\nArtifact  ${artifactId}\n`);

  const scenarios = [
    {
      label: "approval note (docx)",
      task: "Read the inspection report and draft an approval note recommending whether the line can return to service. Assign each finding the severity the evidence supports.",
      tool: "deliverable.createApprovalNote",
      inspect: (content) => {
        check("has a purpose", typeof content.purpose === "string" && content.purpose.length > 30);
        check("has a recommendation", typeof content.recommendation === "string" && content.recommendation.length > 20);
        check("has findings", Array.isArray(content.findings) && content.findings.length > 0, `${content.findings?.length ?? 0} finding(s)`);
        const severities = (content.findings ?? []).map((finding) => finding.severity);
        check("severities are not all informational", new Set(severities).size > 1 || !severities.every((s) => s === "info"), severities.join(", "));
        const mentionsStation41 = JSON.stringify(content).includes("41");
        check("references the actual data (station 41)", mentionsStation41);
      },
    },
    {
      label: "workbook (xlsx)",
      task: "Read the inspection report and build an Excel workbook tabulating the wall thickness readings per station, with the material loss and the annual loss rate calculated from the 2021 baseline over five years.",
      tool: "deliverable.createSpreadsheet",
      inspect: (content) => {
        const tables = content.tables ?? [];
        check("produced at least one table", tables.length > 0, `${tables.length} table(s)`);
        const dataTable = tables.find((table) => table.rows?.length > 1);
        check("a table carries multiple data rows", Boolean(dataTable), dataTable ? `${dataTable.rows.length} rows x ${dataTable.columns.length} cols` : "none");
        // The old template emitted exactly this and nothing else.
        const onlySourceRegister = tables.length === 1 && tables[0]?.name === "SourceEvidence";
        check("did not fall back to a source register", !onlySourceRegister);
        const numericCells = (dataTable?.rows ?? []).flat().filter((cell) => typeof cell === "number");
        check("table contains numeric readings", numericCells.length > 0, `${numericCells.length} numeric cells`);
        const calculations = content.calculations ?? [];
        check("produced calculations", calculations.length > 0, `${calculations.length}`);
        const referencing = calculations.filter((calculation) => /[A-Z]+\d+/.test(calculation.formula));
        check("a formula references cells rather than a constant", referencing.length > 0, calculations.map((c) => c.formula).join(" | ").slice(0, 120));
      },
    },
  ];

  for (const scenario of scenarios) {
    console.log(`\n── ${scenario.label} ──`);
    const created = await http(`/api/workspaces/${workspace.id}/runs`, {
      method: "POST",
      expected: 202,
      token,
      body: { task: scenario.task, artifactId, dataClassification: classification },
    });

    const run = await waitForRun(created.run.id, token);
    check("run completed", run.status === "COMPLETED", run.status === "COMPLETED" ? `model=${run.result?.model}` : JSON.stringify(run.result).slice(0, 200));
    if (run.status !== "COMPLETED") continue;

    check("model authored the body (no fallback)", run.result?.deliverableAuthoring === "model", String(run.result?.deliverableAuthoring));

    const call = (run.toolCalls ?? []).find((toolCall) => toolCall.toolName === scenario.tool);
    check(`called ${scenario.tool}`, Boolean(call), call ? call.status : "not called");
    if (!call?.input?.content) continue;

    scenario.inspect(call.input.content);
    check("produced a downloadable artifact", Boolean(run.result?.artifact?.id));
  }

  console.log(failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILURE(S)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
