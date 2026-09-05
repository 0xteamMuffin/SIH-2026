/**
 * A tiny multi-page PDF writer.
 *
 * Enough to lay out headed, ruled pages of text using the standard Helvetica
 * faces — which pdf.js resolves from its `standard_fonts/` directory, so this
 * also exercises that asset path. Deliberately hand-rolled rather than pulling
 * in a PDF library: the demo generator should not add a dependency the app
 * itself does not need.
 */

const PAGE_WIDTH = 595; // A4 at 72 dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;

/** Escapes the three characters that are special inside a PDF string. */
function escapeText(text) {
  return text.replace(/([\\()])/g, "\\$1");
}

/**
 * Wraps text to the content width. Helvetica averages a shade over half the
 * point size per character, which is close enough for demo layout.
 */
function wrap(text, fontSize, maxWidth) {
  const charsPerLine = Math.floor(maxWidth / (fontSize * 0.5));
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > charsPerLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Lays blocks out across as many pages as needed.
 *
 * A block is `{ text, size, font, gapAfter }` or `{ rule: true }`.
 * Returns an array of content-stream strings, one per page.
 */
function paginate(blocks) {
  const contentWidth = PAGE_WIDTH - MARGIN * 2;
  const pages = [];
  let current = "";
  let cursorY = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    if (current) pages.push(current);
    current = "";
    cursorY = PAGE_HEIGHT - MARGIN;
  };

  for (const block of blocks) {
    if (block.rule) {
      if (cursorY < MARGIN + 20) newPage();
      current += `0.8 0.8 0.8 rg ${MARGIN} ${cursorY} ${contentWidth} 0.7 re f\n`;
      cursorY -= 14;
      continue;
    }

    const size = block.size ?? 10;
    const font = block.font ?? "F1";
    const leading = size * 1.45;

    for (const line of wrap(block.text, size, contentWidth)) {
      if (cursorY < MARGIN + leading) newPage();
      current +=
        `BT /${font} ${size} Tf 0 0 0 rg ` +
        `${MARGIN} ${(cursorY - size).toFixed(1)} Td (${escapeText(line)}) Tj ET\n`;
      cursorY -= leading;
    }
    cursorY -= block.gapAfter ?? 6;
  }

  if (current) pages.push(current);
  return pages.length > 0 ? pages : [""];
}

/**
 * Assembles the PDF file.
 *
 * Cross-reference offsets are computed while the body is built, because
 * pdf.js validates them against the actual byte positions.
 */
export function buildPdf(blocks) {
  const contents = paginate(blocks);
  const pageCount = contents.length;

  // 1 catalog, 2 page tree, 3 regular font, 4 bold font, then two objects per
  // page (the page itself and its content stream).
  const firstPageObject = 5;
  const pageObjectNumbers = contents.map((_, index) => firstPageObject + index * 2);

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}]/Count ${pageCount}>>`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>",
  ];

  contents.forEach((stream, index) => {
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        `/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>` +
        `/Contents ${pageObjectNumbers[index] + 1} 0 R>>`,
    );
    objects.push(`<</Length ${Buffer.byteLength(stream, "latin1")}>>\nstream\n${stream}endstream`);
  });

  const header = "%PDF-1.4\n";
  let body = "";
  const offsets = [];

  objects.forEach((object, index) => {
    offsets.push(header.length + Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = header.length + Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  const trailer =
    `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return { buffer: Buffer.from(header + body + xref + trailer, "latin1"), pageCount };
}
