import { DataClassification } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { allowsExternalInference, mostRestrictiveClassification } from "../src/lib/data-classification.js";

describe("data classification policy", () => {
  it.each([DataClassification.PUBLIC, DataClassification.SYNTHETIC])("allows external inference for %s data", (classification) => {
    expect(allowsExternalInference(classification)).toBe(true);
  });

  it.each([DataClassification.INTERNAL, DataClassification.CONFIDENTIAL])("blocks external inference for %s data", (classification) => {
    expect(allowsExternalInference(classification)).toBe(false);
  });

  it("inherits the most restrictive source classification", () => {
    expect(mostRestrictiveClassification(DataClassification.PUBLIC, DataClassification.CONFIDENTIAL)).toBe(DataClassification.CONFIDENTIAL);
    expect(mostRestrictiveClassification(DataClassification.INTERNAL, DataClassification.SYNTHETIC)).toBe(DataClassification.INTERNAL);
  });
});
