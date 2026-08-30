import { describe, expect, it } from "vitest";
import { validateSourceArtifact } from "../src/modules/artifacts/artifact-validation.js";

describe("artifact upload validation", () => {
  it("accepts UTF-8 text using the normalized MIME type", async () => {
    await expect(validateSourceArtifact("inspection.csv", Buffer.from("tag,status\nP-101,ok\n"))).resolves.toEqual({ extension: "csv", mimeType: "text/csv" });
  });

  it("accepts a PDF signature", async () => {
    await expect(validateSourceArtifact("inspection.pdf", Buffer.from("%PDF-1.7\nsynthetic"))).resolves.toEqual({ extension: "pdf", mimeType: "application/pdf" });
  });

  it("rejects unsupported extensions", async () => {
    await expect(validateSourceArtifact("payload.exe", Buffer.from("MZ"))).rejects.toMatchObject({ status: 415, code: "UNSUPPORTED_FILE_TYPE" });
  });

  it("rejects a binary file disguised as text", async () => {
    await expect(validateSourceArtifact("notes.txt", Buffer.from([0, 1, 2, 3]))).rejects.toMatchObject({ status: 415, code: "FILE_TYPE_MISMATCH" });
  });

  it("rejects a mismatched binary extension", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await expect(validateSourceArtifact("drawing.pdf", png)).rejects.toMatchObject({ status: 415, code: "FILE_TYPE_MISMATCH" });
  });
});
