import ExcelJS from "exceljs";
import { HUMAN_REVIEW_NOTICE, xlsxDeliverableInputSchema, type XlsxDeliverableInput } from "./deliverable-schemas.js";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const COLOR = {
  ink: "FF132A3A",
  steel: "FF2F6173",
  orange: "FFE87722",
  paper: "FFF4F6F5",
  white: "FFFFFFFF",
  muted: "FF667780",
  line: "FFCBD4D6",
} as const;

const FIXED_METADATA_DATE = new Date("2000-01-01T00:00:00.000Z");

function safeSpreadsheetText(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function safeSpreadsheetValue(value: string | number | boolean | null) {
  return typeof value === "string" ? safeSpreadsheetText(value) : value;
}

function columnLetter(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function addSheetFrame(worksheet: ExcelJS.Worksheet, title: string, columnCount: number) {
  const lastColumn = columnLetter(Math.max(columnCount, 1));
  worksheet.mergeCells(`A1:${lastColumn}1`);
  worksheet.mergeCells(`A2:${lastColumn}2`);
  worksheet.getCell("A1").value = safeSpreadsheetText(title);
  worksheet.getCell("A1").font = { name: "Aptos Display", size: 20, bold: true, color: { argb: COLOR.white } };
  worksheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.ink } };
  worksheet.getCell("A1").alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 34;
  worksheet.getCell("A2").value = HUMAN_REVIEW_NOTICE;
  worksheet.getCell("A2").font = { name: "Aptos", size: 9, bold: true, color: { argb: COLOR.white } };
  worksheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.orange } };
  worksheet.getCell("A2").alignment = { vertical: "middle" };
  worksheet.getRow(2).height = 20;
  worksheet.views = [{ state: "frozen", ySplit: 4, activeCell: "A5" }];
  worksheet.properties.defaultRowHeight = 18;
  worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  worksheet.headerFooter.oddFooter = `&L${HUMAN_REVIEW_NOTICE}&RPage &P of &N`;
}

function styleHeader(row: ExcelJS.Row) {
  row.height = 24;
  row.eachCell((cell) => {
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: COLOR.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.steel } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: COLOR.orange } } };
  });
}

function styleBody(worksheet: ExcelJS.Worksheet, firstRow: number, lastRow: number, columnCount: number) {
  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 30;
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      const cell = row.getCell(columnIndex);
      cell.font = { name: "Aptos", size: 10, color: { argb: COLOR.ink } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowIndex % 2 === 0 ? COLOR.paper : COLOR.white } };
      cell.border = { bottom: { style: "thin", color: { argb: COLOR.line } } };
    }
  }
}

function uniqueSheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Data";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const marker = ` ${suffix++}`;
    candidate = `${base.slice(0, 31 - marker.length)}${marker}`;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export async function generateXlsx(input: XlsxDeliverableInput): Promise<Buffer> {
  const value = xlsxDeliverableInputSchema.parse(input);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SIH Deliverable Generator";
  workbook.lastModifiedBy = "SIH Deliverable Generator";
  workbook.created = FIXED_METADATA_DATE;
  workbook.modified = FIXED_METADATA_DATE;
  workbook.title = value.title;
  workbook.subject = "Human-reviewed industrial findings, calculations, and cited sources";
  workbook.company = "SIH";
  workbook.calcProperties.fullCalcOnLoad = true;

  const usedSheetNames = new Set<string>();
  const overview = workbook.addWorksheet(uniqueSheetName("Overview", usedSheetNames), { properties: { tabColor: { argb: COLOR.orange } } });
  addSheetFrame(overview, value.title, 3);
  overview.addRow([]);
  overview.addRow(["Deliverable status", "Sections", "Source references"]);
  overview.addRow(["Draft for human review", value.sections.length, value.citations.length]);
  overview.addRow([]);
  overview.addRow(["Assumptions"]);
  value.assumptions.forEach((assumption, index) => overview.addRow([index + 1, safeSpreadsheetText(assumption)]));
  styleHeader(overview.getRow(4));
  styleHeader(overview.getRow(7));
  styleBody(overview, 5, 5, 3);
  styleBody(overview, 8, 7 + value.assumptions.length, 2);
  overview.columns = [{ width: 24 }, { width: 72 }, { width: 22 }];

  const findings = workbook.addWorksheet(uniqueSheetName("Findings", usedSheetNames), { properties: { tabColor: { argb: COLOR.steel } } });
  addSheetFrame(findings, "Findings register", 6);
  findings.addRow([]);
  findings.addRow(["Section", "Finding", "Severity", "Detail", "Source IDs", "Section context"]);
  value.sections.forEach((section) => section.findings.forEach((finding) => {
    findings.addRow([
      safeSpreadsheetText(section.title),
      safeSpreadsheetText(finding.title),
      finding.severity.toUpperCase(),
      safeSpreadsheetText(finding.detail),
      finding.citationIds.join(", "),
      safeSpreadsheetText(section.summary),
    ]);
  }));
  styleHeader(findings.getRow(4));
  styleBody(findings, 5, findings.rowCount, 6);
  findings.autoFilter = `A4:F${Math.max(findings.rowCount, 4)}`;
  findings.columns = [{ width: 24 }, { width: 30 }, { width: 12 }, { width: 64 }, { width: 24 }, { width: 52 }];

  value.tables.forEach((table, tableIndex) => {
    const worksheet = workbook.addWorksheet(uniqueSheetName(`Data - ${table.title}`, usedSheetNames), { properties: { tabColor: { argb: COLOR.muted } } });
    addSheetFrame(worksheet, table.title, table.columns.length);
    const unitSummary = table.columns.filter((column) => column.unit).map((column) => `${column.header} = ${column.unit}`).join("; ");
    worksheet.getCell("A3").value = safeSpreadsheetText(unitSummary ? `Units: ${unitSummary}` : "Units: none specified");
    worksheet.getCell("A3").font = { name: "Aptos", size: 9, italic: true, color: { argb: COLOR.muted } };
    worksheet.getCell("A3").alignment = { vertical: "middle" };
    if (table.columns.length > 1) worksheet.mergeCells(`A3:${columnLetter(table.columns.length)}3`);
    const headers = table.columns.map((column) => safeSpreadsheetText(column.header));
    worksheet.addTable({
      name: table.name,
      ref: "A4",
      headerRow: true,
      totalsRow: false,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: headers.map((name) => ({ name })),
      rows: table.rows.map((row) => row.map(safeSpreadsheetValue)),
    });
    styleHeader(worksheet.getRow(4));
    worksheet.columns = table.columns.map((column, columnIndex) => {
      const longest = table.rows.reduce((length, row) => Math.max(length, String(row[columnIndex] ?? "").length), headers[columnIndex].length);
      return { width: Math.min(50, Math.max(12, longest + 2)) };
    });
    table.columns.forEach((column, columnIndex) => {
      const numberFormat = column.dataType === "integer" ? "#,##0"
        : column.dataType === "number" ? "#,##0.00"
          : column.dataType === "percentage" ? "0.00%"
            : column.dataType === "text" ? "@" : "General";
      for (let rowIndex = 5; rowIndex <= 4 + table.rows.length; rowIndex += 1) {
        worksheet.getCell(rowIndex, columnIndex + 1).numFmt = numberFormat;
        worksheet.getCell(rowIndex, columnIndex + 1).alignment = { vertical: "top", wrapText: true };
      }
    });
    worksheet.headerFooter.oddHeader = `&L${safeSpreadsheetText(table.title)}&RTable ${tableIndex + 1} of ${value.tables.length}`;
  });

  const calculations = workbook.addWorksheet(uniqueSheetName("Calculations", usedSheetNames), { properties: { tabColor: { argb: COLOR.orange } } });
  addSheetFrame(calculations, "Controlled calculations", 6);
  calculations.addRow([]);
  calculations.addRow(["Metric", "Formula", "Calculated value", "Unit", "Assumptions", "Source IDs"]);
  value.calculations.forEach((calculation) => {
    const row = calculations.addRow([
      safeSpreadsheetText(calculation.label),
      safeSpreadsheetText(`=${calculation.formula}`),
      null,
      safeSpreadsheetText(calculation.unit),
      safeSpreadsheetText(calculation.assumptions.join("; ") || "See workbook assumptions"),
      calculation.citationIds.join(", "),
    ]);
    row.getCell(3).value = calculation.cachedResult === undefined
      ? { formula: calculation.formula }
      : { formula: calculation.formula, result: calculation.cachedResult };
    row.getCell(3).numFmt = "#,##0.00";
  });
  styleHeader(calculations.getRow(4));
  styleBody(calculations, 5, calculations.rowCount, 6);
  calculations.autoFilter = `A4:F${Math.max(calculations.rowCount, 4)}`;
  calculations.columns = [{ width: 30 }, { width: 50 }, { width: 20 }, { width: 14 }, { width: 54 }, { width: 24 }];

  const sources = workbook.addWorksheet(uniqueSheetName("Sources", usedSheetNames), { properties: { tabColor: { argb: COLOR.steel } } });
  addSheetFrame(sources, "Source register", 4);
  sources.addRow([]);
  sources.addRow(["Source ID", "Title", "Reference", "Locator"]);
  value.citations.forEach((citation) => sources.addRow([
    citation.id,
    safeSpreadsheetText(citation.title),
    safeSpreadsheetText(citation.source),
    citation.locator ? safeSpreadsheetText(citation.locator) : "",
  ]));
  styleHeader(sources.getRow(4));
  styleBody(sources, 5, sources.rowCount, 4);
  sources.autoFilter = `A4:D${Math.max(sources.rowCount, 4)}`;
  sources.columns = [{ width: 18 }, { width: 34 }, { width: 72 }, { width: 24 }];

  const output = await workbook.xlsx.writeBuffer({ useStyles: true, useSharedStrings: true });
  return Buffer.from(output);
}
