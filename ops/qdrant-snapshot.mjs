import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode, directory] = process.argv.slice(2);
const baseUrl = process.env.QDRANT_URL?.replace(/\/$/, "");
const apiKey = process.env.QDRANT_API_KEY;

if (!baseUrl || !apiKey || !["backup", "restore"].includes(mode) || !directory) {
  console.error("Usage: QDRANT_URL=... QDRANT_API_KEY=... node qdrant-snapshot.mjs <backup|restore> <directory>");
  process.exit(2);
}

const headers = { "api-key": apiKey };

async function request(endpoint, init = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${endpoint} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function json(endpoint, init) {
  return (await request(endpoint, init)).json();
}

async function backup() {
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  try {
    await access(manifestPath);
    throw new Error(`Refusing to reuse backup directory: ${manifestPath} already exists.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const response = await json("/collections");
  const collections = response.result?.collections ?? [];
  const manifest = { format: 1, createdAt: new Date().toISOString(), collections: [] };

  for (const [index, item] of collections.entries()) {
    const collection = item.name;
    const encodedCollection = encodeURIComponent(collection);
    let snapshot;
    try {
      const created = await json(`/collections/${encodedCollection}/snapshots?wait=true`, { method: "POST" });
      snapshot = created.result?.name;
      if (!snapshot) throw new Error(`Qdrant returned no snapshot name for ${collection}`);

      const file = `${String(index).padStart(4, "0")}.snapshot`;
      const download = await request(`/collections/${encodedCollection}/snapshots/${encodeURIComponent(snapshot)}`);
      const content = Buffer.from(await download.arrayBuffer());
      const sha256 = createHash("sha256").update(content).digest("hex");
      await writeFile(path.join(directory, file), content, { flag: "wx" });
      manifest.collections.push({ collection, snapshot, file, sha256, qdrantChecksum: created.result.checksum ?? null });
    } finally {
      if (snapshot) {
        await request(`/collections/${encodedCollection}/snapshots/${encodeURIComponent(snapshot)}?wait=true`, { method: "DELETE" });
      }
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`Backed up ${manifest.collections.length} Qdrant collection(s).`);
}

async function restore() {
  if (process.env.RESTORE_CONFIRM !== "empty-qdrant-target") {
    throw new Error("Set RESTORE_CONFIRM=empty-qdrant-target to authorize restore into an empty target.");
  }

  const existing = await json("/collections");
  if ((existing.result?.collections ?? []).length !== 0) {
    throw new Error("Refusing to restore: target Qdrant already contains collections.");
  }

  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.format !== 1 || !Array.isArray(manifest.collections)) {
    throw new Error("Unsupported or invalid Qdrant backup manifest.");
  }

  for (const entry of manifest.collections) {
    if (![entry.collection, entry.snapshot, entry.file, entry.sha256].every((value) => typeof value === "string")) {
      throw new Error("Qdrant backup manifest contains an invalid collection entry.");
    }
    if (path.basename(entry.file) !== entry.file) {
      throw new Error(`Qdrant backup manifest contains an unsafe file path: ${entry.file}`);
    }
    const content = await readFile(path.join(directory, entry.file));
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== entry.sha256) throw new Error(`Snapshot checksum mismatch: ${entry.file}`);

    const form = new FormData();
    form.append("snapshot", new Blob([content]), entry.snapshot);
    const query = new URLSearchParams({ wait: "true", priority: "snapshot" });
    if (entry.qdrantChecksum) query.set("checksum", entry.qdrantChecksum);
    await request(`/collections/${encodeURIComponent(entry.collection)}/snapshots/upload?${query}`, {
      method: "POST",
      body: form,
    });
  }

  console.log(`Restored ${manifest.collections.length} Qdrant collection(s).`);
}

await (mode === "backup" ? backup() : restore());
