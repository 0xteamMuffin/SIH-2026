const api = "http://backend:4000";
let failures = 0;
const check = (l, ok, d="") => { console.log(`  ${ok?"ok  ":"FAIL"}  ${l}${d?"  "+d:""}`); if(!ok) failures++; };

async function http(p, o = {}) {
  const h = new Headers(o.headers);
  if (o.token) h.set("authorization", `Bearer ${o.token}`);
  if (typeof o.body === "string") h.set("content-type", "application/json");
  const r = await fetch(`${api}${p}`, { ...o, headers: h });
  const t = await r.text();
  if (!(o.expected ?? [200,201,202]).includes(r.status)) throw new Error(`${p} → ${r.status}: ${t.slice(0,300)}`);
  return t ? JSON.parse(t) : undefined;
}
async function waitRun(id, token, ms=300000) {
  const end = Date.now()+ms;
  while (Date.now() < end) {
    const { run } = await http(`/api/runs/${id}`, { token });
    if (["COMPLETED","FAILED","CANCELLED","WAITING_APPROVAL"].includes(run.status)) return run;
    await new Promise(r=>setTimeout(r,1500));
  }
  throw new Error("timeout");
}

const { token } = await http("/api/auth/login", { method:"POST",
  body: JSON.stringify({ email: process.env.ACCEPTANCE_ADMIN_EMAIL, password: process.env.ACCEPTANCE_ADMIN_PASSWORD }) });
const { workspace } = await http("/api/workspaces", { method:"POST", token, body: JSON.stringify({ name:`loop-${Date.now()}` }) });

const REPORT = `Pipeline Integrity Inspection QA-2291.
Retirement thickness 6.53 mm. Alert threshold 7.00 mm.
Station 41: 2021 reading 9.38 mm, 2026 reading 6.81 mm.
Station 42: 2021 reading 9.44 mm, 2026 reading 7.12 mm.
Station 43: 2021 reading 9.40 mm, 2026 reading 7.35 mm.
Station 41 is the lowest reading and sits below the alert threshold.
No through-wall defects were identified.
`;
const form = new FormData();
form.set("classification", "SYNTHETIC");
form.set("file", new Blob([REPORT], { type: "text/plain" }), "inspection-report.txt");
const { artifact } = await http(`/api/workspaces/${workspace.id}/artifacts`, { method:"POST", token, body: form, expected:[201] });

console.log("\n── the agent decides its own steps ──");
const created = await http(`/api/workspaces/${workspace.id}/runs`, { method:"POST", token,
  body: JSON.stringify({
    task: "Read the attached inspection report and draft an approval note recommending whether the line can return to service.",
    artifactId: artifact.id, dataClassification: "SYNTHETIC" }) });
const run = await waitRun(created.run.id, token);
check("run completed", run.status === "COMPLETED", `${run.status} ${JSON.stringify(run.result?.error ?? "")}`);
check("it took more than one turn", (run.result?.iterations ?? 0) > 1, `${run.result?.iterations} iterations`);
check("it finished by choice, not by exhaustion", run.result?.budgetExhausted === false, String(run.result?.budgetExhausted));
check("it reported confidence", !!run.result?.confidence, run.result?.confidence);

const tools = (run.toolCalls ?? []).map(t => `${t.toolName}:${t.status}`);
console.log("   tools:", tools.join(" | "));
check("it read the document itself", tools.some(t => t.startsWith("artifact.read")));
check("it produced the requested deliverable", tools.some(t => t.startsWith("deliverable.createApprovalNote:COMPLETED")));
check("no fixed model.analyze step remains", !tools.some(t => t.startsWith("model.analyze")));
check("an artifact came back", !!run.result?.artifact?.id, run.result?.artifact?.filename ?? "none");
check("the answer cites the report's data", /6\.81|6\.53|station\s*41/i.test(run.result?.analysis ?? ""), (run.result?.analysis ?? "").slice(0,90));

console.log("\n── a follow-up in the same conversation ──");
const conversationId = crypto.randomUUID();
const t1 = await http(`/api/workspaces/${workspace.id}/runs`, { method:"POST", token,
  body: JSON.stringify({ task: "What is the lowest reading in the attached report?", artifactId: artifact.id, conversationId, dataClassification: "SYNTHETIC" }) });
const r1 = await waitRun(t1.run.id, token);
check("first turn completed", r1.status === "COMPLETED", r1.status);
const t2 = await http(`/api/workspaces/${workspace.id}/runs`, { method:"POST", token,
  body: JSON.stringify({ task: "Which reading did you report as the lowest? Reply with only the number.", conversationId, dataClassification: "SYNTHETIC" }) });
const r2 = await waitRun(t2.run.id, token);
check("follow-up completed", r2.status === "COMPLETED", r2.status);
// Pure recall of the previous turn's answer: no attachment on this run and no
// computation, so it needs neither tools nor approval — only the history.
const a2 = r2.result?.analysis ?? "";
check("follow-up recalled the earlier turn", /6\.81/.test(a2), a2.slice(0,110));

// Control: the same question in a fresh conversation must NOT know the reading,
// which is what proves the pass above came from history and not from a guess.
const t2b = await http(`/api/workspaces/${workspace.id}/runs`, { method:"POST", token,
  body: JSON.stringify({ task: "Which reading did you report as the lowest? Reply with only the number.", conversationId: crypto.randomUUID(), dataClassification: "SYNTHETIC" }) });
const r2b = await waitRun(t2b.run.id, token);
const a2b = r2b.result?.analysis ?? "";
check("a fresh chat does not know the reading", !/6\.81/.test(a2b), a2b.slice(0,110));

console.log("\n── approval still suspends the run ──");
const t3 = await http(`/api/workspaces/${workspace.id}/runs`, { method:"POST", token,
  body: JSON.stringify({ task: "Write and run a Python script that averages 6.81, 7.12 and 7.35, then tell me the result.", dataClassification: "SYNTHETIC" }) });
const r3 = await waitRun(t3.run.id, token);
check("run parked for approval", r3.status === "WAITING_APPROVAL", r3.status);
const pending = (r3.approvals ?? []).find(a => a.status === "PENDING");
check("an approval is pending for the sandbox", pending?.toolName === "sandbox.execute", pending?.toolName ?? "none");

if (pending) {
  // Every high-risk call needs its own approval, so keep approving until the
  // run reaches a terminal state.
  let r4 = r3, approvals = 0;
  while (r4.status === "WAITING_APPROVAL" && approvals < 5) {
    const next = (r4.approvals ?? []).find(a => a.status === "PENDING");
    if (!next) break;
    await http(`/api/agent-approvals/${next.id}/decision`, { method:"POST", token, body: JSON.stringify({ decision: "APPROVED" }) });
    approvals += 1;
    r4 = await waitRun(t3.run.id, token);
  }
  console.log(`   approvals granted: ${approvals}`);
  check("resumes and completes after approval", r4.status === "COMPLETED", `${r4.status} ${JSON.stringify(r4.result?.error ?? "")}`);
  const t4 = (r4.toolCalls ?? []).map(t => `${t.toolName}:${t.status}`);
  console.log("   tools:", t4.join(" | "));
  check("the sandbox actually ran", t4.some(t => t === "sandbox.execute:COMPLETED"), t4.join(" | "));
  check("the answer carries the computed mean", /7\.09|7\.1/.test(r4.result?.analysis ?? ""), (r4.result?.analysis ?? "").slice(0,110));
}

console.log(failures===0 ? "\nALL PASSED\n" : `\n${failures} FAILURE(S)\n`);
process.exitCode = failures===0?0:1;
