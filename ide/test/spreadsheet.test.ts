import { describe, expect, it } from "vitest";

import { MAX_SHEET_ROWS } from "@shared/types.js";

import { parseSpreadsheet } from "../src/main/services/spreadsheet.js";
import { buildCsv, buildLargeXlsx, buildXlsx } from "./fixtures.js";

describe("parseSpreadsheet with an XLSX workbook", () => {
  it("returns every sheet, in workbook order", async () => {
    const model = await parseSpreadsheet("book.xlsx", await buildXlsx());

    expect(model.sheets.map((sheet) => sheet.name)).toEqual(["Readings", "Notes"]);
    expect(model.truncated).toBe(false);
  });

  it("renders headers and values as display text", async () => {
    const model = await parseSpreadsheet("book.xlsx", await buildXlsx());
    const sheet = model.sheets[0]!;

    expect(sheet.rows[0]).toEqual(["Batch", "Value", "Recorded", "Flagged"]);
    expect(sheet.rows[1]?.[0]).toBe("QA-2291");
    expect(sheet.rows[1]?.[1]).toBe("0.81");
  });

  it("shows a formula's computed result rather than the formula", async () => {
    const model = await parseSpreadsheet("book.xlsx", await buildXlsx());
    const meanRow = model.sheets[0]!.rows.find((row) => row[0] === "Mean");

    expect(meanRow?.[1]).toBe("0.875");
    expect(meanRow?.[1]).not.toContain("AVERAGE");
  });

  it("formats dates as ISO calendar dates", async () => {
    const model = await parseSpreadsheet("book.xlsx", await buildXlsx());

    expect(model.sheets[0]!.rows[1]?.[2]).toBe("2026-01-15");
  });

  it("never renders an object placeholder for any cell", async () => {
    const model = await parseSpreadsheet("book.xlsx", await buildXlsx());

    for (const sheet of model.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row) {
          expect(cell ?? "").not.toContain("[object");
        }
      }
    }
  });

  it("caps rows and reports the true total", async () => {
    const rowCount = MAX_SHEET_ROWS + 500;
    const model = await parseSpreadsheet("big.xlsx", await buildLargeXlsx(rowCount));
    const sheet = model.sheets[0]!;

    expect(model.truncated).toBe(true);
    expect(sheet.rows.length).toBeLessThanOrEqual(MAX_SHEET_ROWS);
    // Header row plus the generated data rows.
    expect(sheet.totalRows).toBe(rowCount + 1);
  });
});

describe("parseSpreadsheet with delimited text", () => {
  it("parses CSV into a single sheet", async () => {
    const model = await parseSpreadsheet("data.csv", buildCsv());
    const sheet = model.sheets[0]!;

    expect(model.sheets).toHaveLength(1);
    expect(sheet.rows[0]).toEqual(["Batch", "Value", "Notes"]);
    expect(sheet.totalRows).toBe(3);
  });

  it("keeps a quoted comma inside its own cell", async () => {
    const model = await parseSpreadsheet("data.csv", buildCsv());

    expect(model.sheets[0]!.rows[1]?.[2]).toBe("Within tolerance, no action");
  });

  it("parses TSV on tabs", async () => {
    const tsv = Buffer.from("a\tb\nc\td", "utf8");
    const model = await parseSpreadsheet("data.tsv", tsv);

    expect(model.sheets[0]!.rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("represents an empty cell as null rather than an empty string", async () => {
    const model = await parseSpreadsheet("data.csv", Buffer.from("a,,c", "utf8"));

    expect(model.sheets[0]!.rows[0]).toEqual(["a", null, "c"]);
  });
});
