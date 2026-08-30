import { z } from "zod";

export const ARTIFACT_DELETION_REQUESTED_TOPIC = "artifact.deletion.requested";

const artifactDeletionRequestedSchema = z.object({ deletionJobId: z.string().uuid() }).strict();

export type ArtifactDeletionRequestedMessage = z.infer<typeof artifactDeletionRequestedSchema>;

export function parseArtifactDeletionRequested(value: unknown): ArtifactDeletionRequestedMessage {
  return artifactDeletionRequestedSchema.parse(value);
}

export function decodeArtifactDeletionRequested(content: Buffer): ArtifactDeletionRequestedMessage {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Artifact deletion message must contain valid JSON");
  }
  return parseArtifactDeletionRequested(value);
}
