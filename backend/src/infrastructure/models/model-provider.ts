import { DataClassification } from "@prisma/client";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import type { ModelProfile } from "./model-registry.js";

/**
 * OpenAI-compatible chat completions client.
 *
 * Both the development remote provider and a local runtime expose the same
 * `/chat/completions` shape, including tool calling, so a single request path
 * serves both and moving on-premise is a configuration change rather than a
 * code change.
 */

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(toolCallSchema).nullish(),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

export const visionImageMimeTypes = ["image/png", "image/jpeg", "image/tiff", "image/webp"] as const;
export type VisionImageMimeType = typeof visionImageMimeTypes[number];
export type ModelImageInput = { mimeType: VisionImageMimeType; bytes: Buffer };

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mimeType: VisionImageMimeType; bytes: Buffer };
export type ContentPart = TextPart | ImagePart;

/**
 * A tool call the model asked for. `argumentsJson` is left as the raw string
 * the provider returned: models routinely emit malformed JSON here, and the
 * caller is better placed to decide whether to repair, retry, or reject.
 */
export type ModelToolCall = { id: string; name: string; argumentsJson: string };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content?: string | null; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool offered to the model. `parameters` must be a JSON Schema object. */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type InferenceRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Defaults to "auto" when tools are supplied. */
  toolChoice?: "auto" | "none" | "required";
  maxOutputTokens?: number;
};

export type ModelResponse = {
  /** Null when the model replied with tool calls and no prose. */
  text: string | null;
  toolCalls: ModelToolCall[];
  provider: string;
  modelId: string;
  finishReason?: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

/**
 * Runs one inference turn.
 *
 * Policy is enforced before any network call is attempted, so a blocked
 * classification can never leak as a request that is merely discarded later.
 */
export async function runInference(
  profile: ModelProfile,
  classification: DataClassification,
  request: InferenceRequest,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  assertInferenceAllowed(profile, classification);
  const apiKey = resolveApiKey(profile);

  const images = collectImages(request.messages);
  assertImagesAllowed(profile, images);

  if (request.tools && request.tools.length > 0 && profile.supportsTools === false) {
    throw new AppError(422, `Model profile '${profile.id}' does not support tool calling`, "MODEL_TOOLS_UNSUPPORTED");
  }

  const body: Record<string, unknown> = {
    model: profile.modelId,
    messages: request.messages.map(toWireMessage),
    max_tokens: request.maxOutputTokens ?? profile.maxOutputTokens,
  };
  if (request.tools && request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body["tool_choice"] = request.toolChoice ?? "auto";
  }

  const timeoutSignal = AbortSignal.timeout(env.MODEL_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "Model request was cancelled", "MODEL_REQUEST_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      throw new AppError(504, "Model provider request timed out", "MODEL_TIMEOUT");
    }
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

  const choice = data.choices[0];
  const text = choice.message.content?.trim() || null;
  const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    argumentsJson: call.function.arguments,
  }));

  // A turn with neither prose nor tool calls is unusable, and silently
  // returning it would stall an agent loop with no diagnosable cause.
  if (!text && toolCalls.length === 0) {
    throw new AppError(502, "Model provider returned an empty response", "MODEL_RESPONSE_EMPTY");
  }

  return {
    text,
    toolCalls,
    provider: profile.providerId,
    modelId: profile.modelId,
    finishReason: choice.finish_reason ?? undefined,
    latencyMs: Math.round(performance.now() - startedAt),
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens }
      : undefined,
  };
}

/** A response guaranteed to carry prose, as returned by `askModel`. */
export type TextModelResponse = ModelResponse & { text: string };

/**
 * Single-turn text completion.
 *
 * Retained for the non-agentic paths, which need exactly one prompt and one
 * string back. Guarantees a non-empty `text`, unlike `runInference`.
 */
export async function askModel(
  profile: ModelProfile,
  classification: DataClassification,
  system: string,
  prompt: string,
  signal?: AbortSignal,
  images: readonly ModelImageInput[] = [],
): Promise<TextModelResponse> {
  const content: string | ContentPart[] = images.length > 0
    ? [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, bytes: image.bytes }))]
    : prompt;

  const response = await runInference(
    profile,
    classification,
    { messages: [{ role: "system", content: system }, { role: "user", content }] },
    signal,
  );

  if (!response.text) throw new AppError(502, "Model provider returned an empty response", "MODEL_RESPONSE_EMPTY");
  return { ...response, text: response.text };
}

function assertInferenceAllowed(profile: ModelProfile, classification: DataClassification): void {
  if (profile.location === "remote" && !allowsExternalInference(classification)) {
    throw new AppError(422, "External inference is restricted to public or synthetic data", "EXTERNAL_INFERENCE_BLOCKED");
  }
  if (profile.location === "remote" && !env.ALLOW_REMOTE_INFERENCE) {
    throw new AppError(503, "Remote inference is disabled", "REMOTE_INFERENCE_DISABLED");
  }
}

function resolveApiKey(profile: ModelProfile): string | undefined {
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey) {
    throw new AppError(503, `Model provider credential '${profile.apiKeyEnv}' is not configured`, "MODEL_PROVIDER_NOT_CONFIGURED");
  }
  return apiKey;
}

function collectImages(messages: ChatMessage[]): ImagePart[] {
  const images: ImagePart[] = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") images.push(part);
    }
  }
  return images;
}

function assertImagesAllowed(profile: ModelProfile, images: ImagePart[]): void {
  if (images.length === 0) return;
  if (!profile.capabilities.includes("vision")) {
    throw new AppError(422, `Model profile '${profile.id}' is not vision-capable`, "MODEL_VISION_UNSUPPORTED");
  }
  if (images.length > env.PDF_RENDER_MAX_PAGES) {
    throw new AppError(413, `At most ${env.PDF_RENDER_MAX_PAGES} images may be sent`, "VISION_IMAGE_COUNT_EXCEEDED");
  }

  let totalImageBytes = 0;
  for (const image of images) {
    if (!visionImageMimeTypes.includes(image.mimeType)) {
      throw new AppError(415, `Image MIME type '${image.mimeType}' is not supported`, "VISION_IMAGE_MIME_UNSUPPORTED");
    }
    if (image.mimeType === "image/tiff") {
      throw new AppError(415, "TIFF images are accepted as source artifacts but cannot be sent to OpenAI-compatible vision providers without conversion", "VISION_PROVIDER_MIME_UNSUPPORTED");
    }
    if (image.bytes.byteLength === 0 || image.bytes.byteLength > env.VISION_MAX_IMAGE_BYTES) {
      throw new AppError(413, `Image must contain between 1 and ${env.VISION_MAX_IMAGE_BYTES} bytes`, "VISION_IMAGE_TOO_LARGE");
    }
    totalImageBytes += image.bytes.byteLength;
  }
  if (totalImageBytes > env.VISION_MAX_IMAGE_BYTES) {
    throw new AppError(413, `Combined images cannot exceed ${env.VISION_MAX_IMAGE_BYTES} bytes`, "VISION_IMAGES_TOO_LARGE");
  }
}

/** Converts an internal message into the provider's wire format. */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }

  if (message.role === "assistant") {
    const wire: Record<string, unknown> = { role: "assistant", content: message.content ?? null };
    if (message.toolCalls && message.toolCalls.length > 0) {
      wire["tool_calls"] = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      }));
    }
    return wire;
  }

  if (message.role === "system" || typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }

  return {
    role: "user",
    content: message.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.bytes.toString("base64")}` } },
    ),
  };
}
