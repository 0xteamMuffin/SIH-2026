import { DataClassification } from "@prisma/client";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import type { ModelProfile } from "./model-registry.js";

const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({ content: z.string().nullish() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type ModelResponse = {
  text: string;
  provider: string;
  modelId: string;
  finishReason?: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

export const visionImageMimeTypes = ["image/png", "image/jpeg", "image/tiff", "image/webp"] as const;
export type VisionImageMimeType = typeof visionImageMimeTypes[number];
export type ModelImageInput = { mimeType: VisionImageMimeType; bytes: Buffer };

export async function askModel(profile: ModelProfile, classification: DataClassification, system: string, prompt: string, signal?: AbortSignal, image?: ModelImageInput): Promise<ModelResponse> {
  if (profile.location === "remote" && !allowsExternalInference(classification)) {
    throw new AppError(422, "External inference is restricted to public or synthetic data", "EXTERNAL_INFERENCE_BLOCKED");
  }
  if (profile.location === "remote" && !env.ALLOW_REMOTE_INFERENCE) throw new AppError(503, "Remote inference is disabled", "REMOTE_INFERENCE_DISABLED");
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey) throw new AppError(503, `Model provider credential '${profile.apiKeyEnv}' is not configured`, "MODEL_PROVIDER_NOT_CONFIGURED");
  if (image && !profile.capabilities.includes("vision")) throw new AppError(422, `Model profile '${profile.id}' is not vision-capable`, "MODEL_VISION_UNSUPPORTED");
  if (image && !visionImageMimeTypes.includes(image.mimeType)) throw new AppError(415, `Image MIME type '${image.mimeType}' is not supported`, "VISION_IMAGE_MIME_UNSUPPORTED");
  if (image?.mimeType === "image/tiff") throw new AppError(415, "TIFF images are accepted as source artifacts but cannot be sent to OpenAI-compatible vision providers without conversion", "VISION_PROVIDER_MIME_UNSUPPORTED");
  if (image && (image.bytes.byteLength === 0 || image.bytes.byteLength > env.VISION_MAX_IMAGE_BYTES)) {
    throw new AppError(413, `Image must contain between 1 and ${env.VISION_MAX_IMAGE_BYTES} bytes`, "VISION_IMAGE_TOO_LARGE");
  }
  const timeoutSignal = AbortSignal.timeout(env.MODEL_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const startedAt = performance.now();
  const userContent = image
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` } }]
    : prompt;
  let response: Response;
  try {
    response = await fetch(`${profile.baseUrl}/chat/completions`, { method: "POST", headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ model: profile.modelId, messages: [{ role: "system", content: system }, { role: "user", content: userContent }], max_tokens: profile.maxOutputTokens }), signal: requestSignal });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "Model request was cancelled", "MODEL_REQUEST_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new AppError(504, "Model provider request timed out", "MODEL_TIMEOUT");
    throw new AppError(502, "Model provider is unavailable", "MODEL_PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    const code = response.status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_PROVIDER_ERROR";
    throw new AppError(response.status === 429 ? 503 : 502, `Model provider request failed with status ${response.status}`, code);
  }
  let data: z.infer<typeof responseSchema>;
  try {
    data = responseSchema.parse(await response.json());
  } catch {
    throw new AppError(502, "Model provider returned an invalid response", "MODEL_RESPONSE_INVALID");
  }
  const text = data.choices[0].message.content?.trim();
  if (!text) throw new AppError(502, "Model provider returned an empty response", "MODEL_RESPONSE_EMPTY");
  const usage = data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens } : undefined;
  return { text, provider: profile.providerId, modelId: profile.modelId, finishReason: data.choices[0].finish_reason ?? undefined, latencyMs: Math.round(performance.now() - startedAt), usage };
}
