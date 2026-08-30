import { modelProfiles, type ModelProfile, type TaskCapability } from "./model-registry.js";

export type { ModelProfile, TaskCapability } from "./model-registry.js";

export type RoutingDecision = { capability: TaskCapability; profile: ModelProfile; fallbacks: ModelProfile[]; reason: string };

function inferCapability(task: string, hasAttachment: boolean): TaskCapability {
  const input = task.toLowerCase();
  if (/\b(code|typescript|javascript|python|bug|test|compile|program)\b/.test(input)) return "code";
  if (hasAttachment && /\b(image|drawing|diagram|scan|photo|handwritten|p&id)\b/.test(input)) return "vision";
  if (hasAttachment || /\b(document|report|approval note|summari[sz]e|pdf|inspection)\b/.test(input)) return "document";
  return "general";
}

export function selectModel(task: string, hasAttachment: boolean, profiles = modelProfiles()): RoutingDecision {
  const capability = inferCapability(task, hasAttachment);
  const candidates = profiles
    .filter((item) => item.enabled && item.capabilities.includes(capability))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const [profile, ...fallbacks] = candidates;
  if (!profile) throw new Error(`No model profile supports ${capability}`);
  return { capability, profile, fallbacks, reason: `Task capability '${capability}' selected profile '${profile.id}' by configured priority.` };
}
