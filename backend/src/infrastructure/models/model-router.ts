import { env } from "../../config/env.js";

export type TaskCapability = "document" | "vision" | "code" | "general";
export type ModelProfile = {
  id: string;
  provider: "openrouter" | "local";
  modelId: string;
  capabilities: TaskCapability[];
  endpoint?: string;
  sovereign: boolean;
};

export type RoutingDecision = { capability: TaskCapability; profile: ModelProfile; reason: string };

function inferCapability(task: string, hasAttachment: boolean): TaskCapability {
  const input = task.toLowerCase();
  if (/\b(code|typescript|javascript|python|bug|test|compile|program)\b/.test(input)) return "code";
  if (hasAttachment && /\b(image|drawing|diagram|scan|photo|handwritten|p&id)\b/.test(input)) return "vision";
  if (hasAttachment || /\b(document|report|approval note|summari[sz]e|pdf|inspection)\b/.test(input)) return "document";
  return "general";
}

export function modelProfiles(): ModelProfile[] {
  if (env.MODEL_PROVIDER === "openrouter") {
    return [{ id: "openrouter-development", provider: "openrouter", modelId: env.OPENROUTER_MODEL, capabilities: ["document", "vision", "code", "general"], sovereign: false }];
  }
  return [
    { id: "local-general", provider: "local", endpoint: env.LOCAL_MODEL_BASE_URL, modelId: env.LOCAL_GENERAL_MODEL, capabilities: ["general", "document"], sovereign: true },
    { id: "local-vision", provider: "local", endpoint: env.LOCAL_MODEL_BASE_URL, modelId: env.LOCAL_VISION_MODEL, capabilities: ["vision", "document"], sovereign: true },
    { id: "local-code", provider: "local", endpoint: env.LOCAL_MODEL_BASE_URL, modelId: env.LOCAL_CODE_MODEL, capabilities: ["code"], sovereign: true },
  ];
}

export function selectModel(task: string, hasAttachment: boolean): RoutingDecision {
  const capability = inferCapability(task, hasAttachment);
  const profile = modelProfiles().find((item) => item.capabilities.includes(capability));
  if (!profile) throw new Error(`No model profile supports ${capability}`);
  return { capability, profile, reason: `Task capability '${capability}' selected from task content and attachment context.` };
}
