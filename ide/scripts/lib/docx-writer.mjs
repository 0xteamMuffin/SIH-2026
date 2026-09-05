import JSZip from "jszip";

/**
 * A small WordprocessingML writer for the demo documents.
 *
 * Uses direct run/paragraph formatting rather than a `styles.xml`, which keeps
 * the package to four parts while still exercising headings, body text, and
 * tables in `docx-preview`.
 */

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Word measures font size in half-points. */
function run(text, { bold = false, size = 11, color = "000000" } = {}) {
  const properties =
    `<w:rPr>${bold ? "<w:b/>" : ""}` +
    `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` +
    `<w:color w:val="${color}"/>` +
    `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>`;
  return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

export function heading(text, level = 1) {
  const size = level === 1 ? 18 : 13;
  const spacing = `<w:pPr><w:spacing w:before="${level === 1 ? 0 : 240}" w:after="120"/></w:pPr>`;
  return `<w:p>${spacing}${run(text, { bold: true, size })}</w:p>`;
}

export function paragraph(text, options = {}) {
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${run(text, options)}</w:p>`;
}

export function bullet(text) {
  // A literal bullet glyph rather than real numbering, which would need a
  // numbering.xml part for no visual gain here.
  return `<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="360"/></w:pPr>${run(`• ${text}`)}</w:p>`;
}

export function table(rows, { headerRow = true } = {}) {
  const columnCount = rows[0]?.length ?? 0;
  const grid = `<w:tblGrid>${"<w:gridCol w:w=\"2400\"/>".repeat(columnCount)}</w:tblGrid>`;
  const borders =
    "<w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="BFBFBF"/>`)
      .join("") +
    "</w:tblBorders>";
  const properties = `<w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>`;

  const body = rows
    .map((cells, rowIndex) => {
      const isHeader = headerRow && rowIndex === 0;
      const shading = isHeader ? '<w:shd w:val="clear" w:fill="F2F2F2"/>' : "";
      const tableCells = cells
        .map(
          (cell) =>
            `<w:tc><w:tcPr>${shading}</w:tcPr>` +
            `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(String(cell), { bold: isHeader, size: 10 })}</w:p></w:tc>`,
        )
        .join("");
      return `<w:tr>${tableCells}</w:tr>`;
    })
    .join("");

  return `<w:tbl>${properties}${grid}${body}</w:tbl>`;
}

export async function buildDocx(bodyParts) {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyParts.join("\n    ")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
  </w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer" });
}
