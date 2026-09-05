import { DataClassification } from "@prisma/client";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { modelProfiles, type ModelProfile, type TaskCapability } from "./model-registry.js";

export type { ModelProfile, TaskCapability } from "./model-registry.js";

export type RoutingDecision = { capability: TaskCapability; profile: ModelProfile; fallbacks: ModelProfile[]; reason: string };

/**
 * What a turn needs from a model in order to do the work at all.
 *
 * These are requirements, not preferences. They are derived from facts — an
 * attachment's media type, whether extraction produced any text — and from
 * needs the agent discovers while working, never from words in the request.
 * Inferring them from the request text guesses at the work before any of it
 * has been done, and guesses wrong on exactly the inputs that matter: a scan
 * that never says "scan", a drawing that never says "drawing".
 *
 * Preference between profiles that all meet the requirements is expressed by
 * `priority` in the registry, not here.
 */
export type ModelRequirements = {
  /** The input carries meaning that can only be read by looking at it. */
  vision: boolean;
  /** The caller supplies tools, so the profile must be able to call them. */
  tools: boolean;
};

/**
 * Whether a source document has to be seen rather than read.
 *
 * An image has no text layer to extract. A document that extracted to nothing
 * is a scan: its words exist only as pixels, so a text model would answer
 * about an empty page.
 */
export function visionRequiredForSource(input: { mimeType?: string; extractedCharacters?: number }): boolean {
  if (input.mimeType?.startsWith("image/")) return true;
  return input.extractedCharacters === 0;
}

/**
 * The capability a set of requirements maps onto.
 *
 * Only input modality is a hard requirement, so it is the only thing that
 * narrows the pool. Task specialisations are quality preferences and are
 * ordered by `priority` instead of being filtered on.
 */
export function requiredCapability(requirements: ModelRequirements): TaskCapability {
  return requirements.vision ? "vision" : "general";
}

function describe(requirements: ModelRequirements): string {
  const needs = [requirements.vision ? "visual input" : "text input"];
  if (requirements.tools) needs.push("tool calling");
  return needs.join(" and ");
}

function ordered(profiles: ModelProfile[], capability: TaskCapability, requirements: ModelRequirements): ModelProfile[] {
  return profiles
    .filter((profile) => profile.enabled && profile.capabilities.includes(capability))
    // The agent loop always offers tools, so a profile that cannot call them
    // cannot run a turn. Filtering here means such a profile is never chosen,
    // rather than being chosen and then failing.
    .filter((profile) => !requirements.tools || profile.supportsTools !== false)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export function selectModel(requirements: ModelRequirements, profiles = modelProfiles()): RoutingDecision {
  const capability = requiredCapability(requirements);
  const [profile, ...fallbacks] = ordered(profiles, capability, requirements);
  if (!profile) throw new Error(`No model profile provides ${describe(requirements)}`);
  return {
    capability,
    profile,
    fallbacks,
    reason: `Requirements (${describe(requirements)}) selected profile '${profile.id}' by configured priority.`,
  };
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

/**
 * Routes a single turn.
 *
 * Called before every model call rather than once per run, because what the
 * work needs is not fully knowable at admission: reading a document is what
 * reveals that it is a scan. The data-policy filter stays here in code and is
 * never influenced by the model — the agent can say what it needs to do, but
 * not what it is permitted to use.
 *
 * A run sticks with the profile it has been using while that profile still
 * meets the turn's requirements, so an ordinary turn does not migrate between
 * providers for no reason.
 */
export function routeForTurn(
  input: {
    requirements: ModelRequirements;
    classification: DataClassification;
    /** Profile the run has been using, preferred while it remains eligible. */
    preferredProfileId?: string;
  },
  profiles = modelProfiles(),
): RoutingDecision {
  const decision = eligibleRoutingDecision(selectModel(input.requirements, profiles), input.classification);
  if (!input.preferredProfileId) return decision;

  const chain = [decision.profile, ...decision.fallbacks];
  const preferred = chain.find((profile) => profile.id === input.preferredProfileId);
  if (!preferred) {
    return {
      ...decision,
      reason: `${decision.reason} Profile '${input.preferredProfileId}' does not provide ${describe(input.requirements)}, so '${decision.profile.id}' took over.`,
    };
  }
  return { ...decision, profile: preferred, fallbacks: chain.filter((profile) => profile.id !== preferred.id) };
}
