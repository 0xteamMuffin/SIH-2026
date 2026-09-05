import { extname } from "node:path";

import ExcelJS from "exceljs";
import Papa from "papaparse";

import { MAX_SHEET_ROWS, type SheetData, type SheetRow, type SpreadsheetModel } from "@shared/types.js";

/**
 * Parses a workbook into display strings.
 *
 * This runs in the main process because `exceljs` depends on Node streams and
 * the filesystem, and dragging that into a sandboxed renderer would mean
 * polyfilling `Buffer` and `process`. CSV is handled here too so the renderer
 * has a single code path for every spreadsheet.
 *
 * The result is intentionally lossy — formatted text only, no styles or
 * formulas — because the renderer's job is to show the data, not round-trip
 * the file.
 */
export async function parseSpreadsheet(path: string, bytes: Buffer): Promise<SpreadsheetModel> {
  const extension = extname(path).toLowerCase();

  if (extension === ".csv" || extension === ".tsv") {
    return parseDelimited(bytes, extension === ".tsv" ? "\t" : ",");
  }
  return parseWorkbook(bytes);
}

function parseDelimited(bytes: Buffer, delimiter: string): SpreadsheetModel {
  const parsed = Papa.parse<string[]>(bytes.toString("utf8"), {
    delimiter,
    skipEmptyLines: "greedy",
  });

  const allRows = parsed.data;
  const rows: SheetRow[] = allRows.slice(0, MAX_SHEET_ROWS).map((row) => row.map(emptyToNull));
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  return {
    sheets: [{ name: "Sheet 1", totalRows: allRows.length, columnCount, rows }],
    truncated: allRows.length > rows.length,
  };
}

async function parseWorkbook(bytes: Buffer): Promise<SpreadsheetModel> {
  const workbook = new ExcelJS.Workbook();
  // `bytes` is a Node Buffer, which satisfies exceljs's ArrayBuffer parameter.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const sheets: SheetData[] = [];
  let truncated = false;

  for (const worksheet of workbook.worksheets) {
    // `actualRowCount` skips trailing blank rows that `rowCount` includes.
    const totalRows = worksheet.actualRowCount;
    const columnCount = worksheet.actualColumnCount;
    const rows: SheetRow[] = [];

    // eachRow with includeEmpty keeps row indices aligned with the source, so
    // a blank row in the middle of a table stays blank instead of collapsing.
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > MAX_SHEET_ROWS) {
        truncated = true;
        return;
      }

      const cells: (string | null)[] = [];
      for (let column = 1; column <= columnCount; column += 1) {
        cells.push(formatCellValue(row.getCell(column).value));
      }
      rows.push(cells);
    });

    sheets.push({ name: worksheet.name, totalRows, columnCount, rows });
  }

  if (sheets.length === 0) {
    sheets.push({ name: "Sheet 1", totalRows: 0, columnCount: 0, rows: [] });
  }

  return { sheets, truncated };
}

/**
 * Renders a cell as the text a reader expects.
 *
 * exceljs returns a union covering rich text, hyperlinks, formulas, errors and
 * dates, so each case is handled explicitly rather than relying on `String()`
 * — which would turn a formula cell into `[object Object]`.
 */
function formatCellValue(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === "object") {
    if ("richText" in value) {
      return emptyToNull(value.richText.map((run) => run.text).join(""));
    }
    // A formula cell carries its computed result; show that, not the formula.
    if ("result" in value) return formatCellValue(value.result ?? null);
    if ("text" in value) return emptyToNull(String(value.text));
    if ("error" in value) return String(value.error);
    if ("sharedFormula" in value) return null;
    return null;
  }

  return emptyToNull(String(value));
}

function emptyToNull(text: string): string | null {
  return text.length > 0 ? text : null;
}
