import { env } from "../../config/env.js";
import type { ModelProfile } from "./model-router.js";

export async function askModel(profile: ModelProfile, system: string, prompt: string) {
  if (profile.provider === "openrouter" && !env.OPENROUTER_API_KEY) {
    throw new Error("OpenRouter is not configured. Set OPENROUTER_API_KEY or use the sovereign local-model deployment.");
  }
  const settings = profile.provider === "openrouter"
    ? { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY! }
    : { name: "local", baseURL: profile.endpoint!, apiKey: env.LOCAL_MODEL_API_KEY };
  const response = await fetch(`${settings.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: profile.modelId, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 900 }) });
  if (!response.ok) throw new Error(`Model provider request failed (${response.status})`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
}
