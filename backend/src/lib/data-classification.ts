import { DataClassification } from "@prisma/client";

const sensitivity: Record<DataClassification, number> = {
  [DataClassification.PUBLIC]: 0,
  [DataClassification.SYNTHETIC]: 0,
  [DataClassification.INTERNAL]: 1,
  [DataClassification.CONFIDENTIAL]: 2,
};

export function mostRestrictiveClassification(...values: DataClassification[]) {
  return values.reduce((current, value) => sensitivity[value] > sensitivity[current] ? value : current);
}

export function allowsExternalInference(classification: DataClassification) {
  return classification === DataClassification.PUBLIC || classification === DataClassification.SYNTHETIC;
}
