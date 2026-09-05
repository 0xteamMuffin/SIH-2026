const api = "http://backend:4000";
const http = async (p, o={}) => {
  const r = await fetch(api+p, {...o, headers: {...(o.token?{authorization:`Bearer ${o.token}`}:{}), ...(typeof o.body==="string"?{"content-type":"application/json"}:{}), ...o.headers}});
  const t = await r.text(); let b; try { b=JSON.parse(t); } catch { b=t; }
  if (!(o.expected ?? [200,201,202]).includes(r.status)) throw new Error(`${p} → ${r.status}: ${t.slice(0,200)}`);
  return b;
};
let failures = 0;
const check = (l, ok, d="") => { console.log(`  ${ok?"ok  ":"FAIL"}  ${l}${d?"  "+d:""}`); if(!ok) failures++; };
const login = await http("/api/auth/login", {method:"POST", body: JSON.stringify({email:process.env.ACCEPTANCE_ADMIN_EMAIL, password:process.env.ACCEPTANCE_ADMIN_PASSWORD})});
const token = login.accessToken ?? login.token;
const mkws = async (n) => (await http("/api/workspaces", {method:"POST", token, expected:[201], body: JSON.stringify({name:n, dataClassification:"SYNTHETIC"})})).workspace;
const wsA = await mkws(`chat-home-${Date.now()}`);
const wait = async (id) => { let r; for (let i=0;i<90;i++){ r=(await http(`/api/runs/${id}`,{token})).run; if(["COMPLETED","FAILED","CANCELLED","WAITING_APPROVAL"].includes(r.status)) break; await new Promise(s=>setTimeout(s,2000)); } return r; };
const start = async (ws, task, conversationId, artifactId) => {
  const c = await http(`/api/workspaces/${ws.id}/runs`, {method:"POST", token, body: JSON.stringify({task, conversationId, dataClassification:"SYNTHETIC", ...(artifactId?{artifactId}:{})})});
  return wait(c.run.id);
};
const conversationId = crypto.randomUUID();

const md = Buffer.from("# Inspection QA-2291\n\nStation 44 minimum wall thickness: 6.81 mm. Retirement thickness: 6.40 mm.\nStations 41-46 inspected. Interval currently 48 months.\n","utf8");
const form = new FormData();
form.set("classification","SYNTHETIC");
form.set("file", new Blob([md],{type:"text/markdown"}), "qa-2291.md");
const art = (await http(`/api/workspaces/${wsA.id}/artifacts`, {method:"POST", token, expected:[201], body: form})).artifact;

console.log("\n── turn 1: a long answer with a deliverable ──");
const t1 = await start(wsA, "Read this inspection report and draft an approval note recommending whether the pipeline returns to service.", conversationId, art.id);
check("turn 1 completed", t1.status === "COMPLETED", t1.status);
check("turn 1 answered from the report", /6\.81|thickness|QA-2291/i.test(t1.result?.analysis ?? ""), `${(t1.result?.analysis ?? "").length} chars`);

// The IDE's session workspace used to drift here — new workspaces appearing
// (as any other run creates them) changed which one "workspaces[0]" meant.
const wsB = await mkws(`noise-${Date.now()}`);
console.log(`\n── a newer workspace now exists (${wsB.name}) ──`);

console.log("\n── turn 2: the exact follow-up that failed ──");
const t2 = await start(wsA, "can u summarize even shorter", conversationId);
check("turn 2 completed", t2.status === "COMPLETED", t2.status);
const a2 = t2.result?.analysis ?? "";
check("it did NOT claim to have no content", !/without content|provide me with|no content|cannot summarize anything/i.test(a2), a2.slice(0,110));
check("it summarised the actual report", /6\.81|station|thickness|service/i.test(a2), a2.slice(0,110));
check("the summary is shorter than turn 1", a2.length < (t1.result?.analysis ?? "").length, `${a2.length} < ${(t1.result?.analysis ?? "").length}`);

console.log("\n── control: same follow-up in the wrong workspace stays blind ──");
const t3 = await start(wsB, "can u summarize even shorter", conversationId);
check("cross-workspace history is not readable", /without content|provide me|cannot|no content|don't have/i.test(t3.result?.analysis ?? ""), (t3.result?.analysis ?? "").slice(0,90));

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures===0?0:1);
