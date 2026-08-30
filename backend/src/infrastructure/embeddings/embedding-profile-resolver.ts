import { DataClassification } from "@prisma/client";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { modelProfiles, type EmbeddingModelProfile, type ModelProfile } from "../models/model-registry.js";

function isTextEmbeddingProfile(profile: ModelProfile): profile is EmbeddingModelProfile {
  return profile.capabilities.includes("embedding")
    && profile.revision !== undefined
    && profile.dimensions !== undefined
    && profile.distance !== undefined
    && profile.maxBatchInputs !== undefined
    && profile.maxBatchCharacters !== undefined
    && profile.maxInputCharacters !== undefined
    && profile.inputModalities?.includes("TEXT") === true;
}

export function selectEmbeddingProfile(
  classification: DataClassification,
  profiles: ModelProfile[] = modelProfiles(),
): EmbeddingModelProfile {
  const profile = profiles
    .filter(isTextEmbeddingProfile)
    .filter((candidate) => candidate.enabled)
    .filter((candidate) => candidate.location === "local" || allowsExternalInference(classification))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];

  if (!profile) throw new Error("No TEXT embedding profile is available under the current data policy");
  return profile;
}
