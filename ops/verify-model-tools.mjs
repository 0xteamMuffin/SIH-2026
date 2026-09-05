/**
 * Probes every configured model profile to see whether it can actually make a
 * tool call, and reports where `supportsTools` in the registry disagrees.
 *
 * The flag is a claim about a provider's behaviour, and getting it wrong is
 * expensive in both directions: a false positive makes the agent loop fail at
 * runtime with a confusing error, and a false negative silently downgrades a
 * capable model. This settles it empirically rather than by reputation.
 *
 * Requires network access and provider credentials, so it is a development
 * check. It is not part of the sovereign verification suite.
 *
 * Usage: node ops/verify-model-tools.mjs [profileId ...]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// MODEL_CONFIG_PATH is written relative to the backend, which is where the
// services run from. Resolve it there rather than against this script's cwd.
const configPath = process.env.MODEL_CONFIG_PATH
  ? path.resolve(path.join(root, "backend"), process.env.MODEL_CONFIG_PATH)
  : path.join(root, "backend/config/models.json");
const REQUEST_TIMEOUT_MS = 45_000;

/** A trivial tool the model should reach for when asked a question it cannot answer alone. */
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "get_reading",
    description: "Look up the recorded wall-thickness reading for a numbered inspection station.",
    parameters: {
      type: "object",
      properties: { station: { type: "integer", description: "Station number." } },
      required: ["station"],
      additionalProperties: false,
    },
  },
};

const PROBE_MESSAGES = [
  { role: "system", content: "Use the supplied tool when you need recorded data. Do not guess." },
  { role: "user", content: "What was the wall-thickness reading at station 41?" },
];

function loadProfiles() {
  const configuration = JSON.parse(readFileSync(configPath, "utf8"));
  const providers = new Map(
    configuration.providers.map((provider) => [
      provider.id,
      {
        ...provider,
        baseUrl: (provider.baseUrl ?? (provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined) ?? "").replace(/\/$/, ""),
      },
    ]),
  );

  return configuration.models.map((model) => {
    const provider = providers.get(model.providerId) ?? {};
    return {
      ...model,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      location: provider.location,
    };
  });
}

/** Returns "yes" / "no" / a skip or error reason. */
async function probe(profile) {
  if (!profile.baseUrl) return { outcome: "skipped", detail: "no base URL configured" };
  if (profile.apiKeyEnv && !process.env[profile.apiKeyEnv]) {
    return { outcome: "skipped", detail: `${profile.apiKeyEnv} not set` };
  }

  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  let response;
  try {
    response = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: profile.modelId,
        messages: PROBE_MESSAGES,
        tools: [PROBE_TOOL],
        tool_choice: "auto",
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { outcome: "error", detail: error instanceof Error ? error.name : "request failed" };
  }

  if (!response.ok) {
    // Rate limiting and server faults say nothing about tool support, and
    // treating them as a refusal would advise disabling a working model.
    if (response.status === 429 || response.status >= 500) {
      return { outcome: "inconclusive", detail: `HTTP ${response.status} — transient, retry` };
    }
    // A 4xx here is the usual way a provider rejects the `tools` parameter.
    const body = await response.text().catch(() => "");
    const hint = /tool|function/i.test(body) ? " (rejected the tools parameter)" : "";
    return { outcome: "no", detail: `HTTP ${response.status}${hint}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { outcome: "error", detail: "invalid JSON response" };
  }

  const message = payload?.choices?.[0]?.message ?? {};
  const calls = message.tool_calls ?? [];
  if (calls.length > 0) {
    return { outcome: "yes", detail: `called ${calls[0]?.function?.name ?? "a tool"}` };
  }
  // Accepting `tools` without using them is not proof of support, but it is
  // not a failure either — the model may simply have chosen to answer.
  return { outcome: "unused", detail: "accepted tools but answered directly" };
}

const requested = process.argv.slice(2);
const profiles = loadProfiles().filter((profile) => {
  if (requested.length > 0) return requested.includes(profile.id);
  return profile.enabled !== false && !profile.capabilities.some((capability) => capability === "embedding" || capability === "reranking");
});

if (profiles.length === 0) {
  console.error("No matching model profiles.");
  process.exit(1);
}

console.log(`\nProbing ${profiles.length} profile(s) from ${path.relative(root, configPath)}\n`);

const disagreements = [];
for (const profile of profiles) {
  const claimed = profile.supportsTools === true;
  const { outcome, detail } = await probe(profile);

  const symbol = { yes: "yes", no: "NO", unused: "?", inconclusive: "~", skipped: "-", error: "!" }[outcome];
  console.log(
    `  ${symbol.padEnd(4)} ${profile.id.padEnd(28)} claimed=${String(claimed).padEnd(5)} ${detail}`,
  );

  if (outcome === "yes" && !claimed) disagreements.push(`${profile.id}: works, but supportsTools is not set`);
  if (outcome === "no" && claimed) disagreements.push(`${profile.id}: supportsTools is set, but the provider refused`);
}

if (disagreements.length > 0) {
  console.log("\nRegistry disagrees with observed behaviour:");
  for (const line of disagreements) console.log(`  - ${line}`);
  console.log("\nUpdate `supportsTools` in the model registry to match.\n");
  process.exit(1);
}

console.log("\nNo disagreements between the registry and observed behaviour.\n");
