import ExcelJS from "exceljs";
import JSZip from "jszip";

/**
 * Builders for real document fixtures.
 *
 * Files are generated rather than committed as binaries so the tests stay
 * readable and reviewable — you can see exactly what is in each fixture.
 */

export async function buildXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const readings = workbook.addWorksheet("Readings");
  readings.addRow(["Batch", "Value", "Recorded", "Flagged"]);
  readings.addRow(["QA-2291", 0.81, new Date(Date.UTC(2026, 0, 15)), false]);
  readings.addRow(["QA-2292", 0.94, new Date(Date.UTC(2026, 0, 16)), true]);
  // A formula cell: exceljs stores both the formula and its cached result,
  // and the viewer must show the result.
  readings.getCell("B4").value = { formula: "AVERAGE(B2:B3)", result: 0.875 };
  readings.getCell("A4").value = "Mean";

  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Deviation logged under DEV-114"]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function buildLargeXlsx(rowCount: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Bulk");
  sheet.addRow(["Index", "Value"]);
  for (let index = 1; index <= rowCount; index += 1) {
    sheet.addRow([index, index * 2]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildCsv(): Buffer {
  return Buffer.from(
    ["Batch,Value,Notes", 'QA-2291,0.81,"Within tolerance, no action"', "QA-2292,0.94,Breach"].join(
      "\n",
    ),
    "utf8",
  );
}

/**
 * A minimal but structurally valid .docx — the four parts Word requires.
 */
export async function buildDocx(text: string): Promise<Buffer> {
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
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * A minimal PDF drawing one filled black square on a white page.
 *
 * A shape rather than text, so a rendering assertion can check for dark
 * pixels without depending on font substitution. Cross-reference offsets are
 * computed as the file is assembled, because pdf.js validates them.
 */
export function buildPdf(): Buffer {
  const content = "0 0 0 rg 20 20 160 160 re f\n";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<<>>>>",
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
  ];

  const header = "%PDF-1.4\n";
  let body = "";
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(header.length + body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}

/** A 2×2 red PNG. */
export function buildPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
    "base64",
  );
}
