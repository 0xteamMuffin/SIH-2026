import { DataClassification } from "@prisma/client";
import { allowsExternalInference } from "../../lib/data-classification.js";
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

export function eligibleRoutingDecision(decision: RoutingDecision, classification: DataClassification): RoutingDecision {
  const candidates = [decision.profile, ...decision.fallbacks].filter((profile) => profile.location === "local" || allowsExternalInference(classification));
  const [profile, ...fallbacks] = candidates;
  if (!profile) throw new Error(`No model profile supports ${decision.capability} under the current data policy`);
  const reason = profile.id === decision.profile.id
    ? decision.reason
    : `${decision.reason} Profile '${profile.id}' was selected because the persisted primary is not eligible under the current data policy.`;
  return { ...decision, profile, fallbacks, reason };
}

export function routingDecisionForPersistedRun(
  run: { taskCapability: string; modelProfile: string; modelReason: string; dataClassification: DataClassification },
  profiles = modelProfiles(),
): RoutingDecision {
  const capabilities: TaskCapability[] = ["general", "document", "vision", "code"];
  if (!capabilities.includes(run.taskCapability as TaskCapability)) throw new Error(`Persisted task capability '${run.taskCapability}' is invalid`);
  const capability = run.taskCapability as TaskCapability;
  const candidates = profiles
    .filter((profile) => profile.enabled && profile.capabilities.includes(capability))
    .filter((profile) => profile.location === "local" || allowsExternalInference(run.dataClassification))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const persisted = candidates.find((profile) => profile.id === run.modelProfile);
  const ordered = persisted ? [persisted, ...candidates.filter((profile) => profile.id !== persisted.id)] : candidates;
  const [profile, ...fallbacks] = ordered;
  if (!profile) throw new Error(`No model profile supports '${capability}' under the current inference policy`);
  const reason = persisted
    ? run.modelReason
    : `${run.modelReason} Persisted profile '${run.modelProfile}' is no longer eligible; current profile '${profile.id}' was selected.`;
  return { capability, profile, fallbacks, reason };
}
