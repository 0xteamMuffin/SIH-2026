import { useState } from "react";

import { MAX_SHEET_ROWS, type SheetData, type SpreadsheetModel } from "@shared/types.js";

import { useDocumentResource } from "../../hooks/useDocumentBytes.js";
import { PreviewError, PreviewLoading, PreviewNote } from "./PreviewState.js";
import type { DocumentViewerProps } from "./registry.js";

/**
 * Renders a workbook as a table.
 *
 * Parsing happens in main (see `services/spreadsheet.ts`), so this receives
 * plain display strings and both XLSX and CSV arrive through one path.
 */
export function SpreadsheetViewer({ document }: DocumentViewerProps): React.JSX.Element {
  const { data, isLoading, error } = useDocumentResource<SpreadsheetModel>(document, (documentId) =>
    window.workbench.documents.readSpreadsheet(documentId),
  );
  const [activeSheet, setActiveSheet] = useState(0);

  if (isLoading) return <PreviewLoading label="Reading spreadsheet…" />;
  if (error) return <PreviewError message={error} />;
  if (!data || data.sheets.length === 0) return <PreviewError message="No sheets in this workbook." />;

  const sheet = data.sheets[Math.min(activeSheet, data.sheets.length - 1)];
  if (!sheet) return <PreviewError message="No sheets in this workbook." />;

  return (
    <div className="sheet">
      {data.sheets.length > 1 && (
        <div className="sheet__tabs" role="tablist">
          {data.sheets.map((candidate, index) => (
            <button
              key={candidate.name}
              type="button"
              role="tab"
              aria-selected={index === activeSheet}
              className={`sheet__tab ${index === activeSheet ? "sheet__tab--active" : ""}`}
              onClick={() => setActiveSheet(index)}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}

      <SheetTable sheet={sheet} />

      {sheet.totalRows > sheet.rows.length && (
        <PreviewNote>
          Showing the first {MAX_SHEET_ROWS.toLocaleString()} of {sheet.totalRows.toLocaleString()} rows.
        </PreviewNote>
      )}
    </div>
  );
}

/**
 * The first row is treated as a header, which is right for the overwhelming
 * majority of real sheets and costs nothing when it is wrong.
 */
function SheetTable({ sheet }: { sheet: SheetData }): React.JSX.Element {
  const [header, ...body] = sheet.rows;

  if (!header) return <PreviewNote>This sheet is empty.</PreviewNote>;

  return (
    <div className="sheet__scroll">
      <table className="sheet__table">
        <thead>
          <tr>
            <th className="sheet__corner" scope="col" aria-label="Row number" />
            {header.map((cell, index) => (
              <th key={index} scope="col">
                {cell ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {/* +2: one for the header row, one to make it one-based. */}
              <th className="sheet__rownum" scope="row">
                {rowIndex + 2}
              </th>
              {Array.from({ length: sheet.columnCount }, (_, columnIndex) => (
                <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
