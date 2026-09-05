import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import {
  HUMAN_REVIEW_NOTICE,
  type DocxDeliverableInput,
} from "../deliverables/deliverable-schemas.js";

const SEVERITY_LABELS: Record<DocxDeliverableInput["findings"][number]["severity"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Information",
};

/**
 * Renders an approval note from content the model authored.
 *
 * Only the document furniture — headings, ordering, the review notice — is
 * fixed here. Purpose, findings, severities, recommendation and conditions all
 * come from the model and are validated before they arrive, so the note
 * reflects the actual analysis rather than a template with prose pasted in.
 */
export async function approvalNoteDocx(input: DocxDeliverableInput): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: HUMAN_REVIEW_NOTICE, bold: true, color: "B45309" })],
    }),

    new Paragraph({ text: "Purpose", heading: HeadingLevel.HEADING_1 }),
    new Paragraph(input.purpose),
  ];

  if (input.background) {
    children.push(
      new Paragraph({ text: "Background", heading: HeadingLevel.HEADING_1 }),
      new Paragraph(input.background),
    );
  }

  children.push(new Paragraph({ text: "Findings", heading: HeadingLevel.HEADING_1 }));
  for (const finding of input.findings) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `[${SEVERITY_LABELS[finding.severity]}] `, bold: true }),
          new TextRun({ text: finding.title, bold: true }),
        ],
      }),
      new Paragraph(finding.detail),
      // Inline source markers, so a reviewer can trace any finding back to the
      // reference list without cross-checking the whole document.
      new Paragraph({
        children: [new TextRun({ text: `Sources: ${finding.citationIds.join(", ")}`, italics: true, size: 18 })],
      }),
    );
  }

  children.push(
    new Paragraph({ text: "Recommendation", heading: HeadingLevel.HEADING_1 }),
    new Paragraph(input.recommendation),
  );

  if (input.conditions && input.conditions.length > 0) {
    children.push(new Paragraph({ text: "Conditions", heading: HeadingLevel.HEADING_1 }));
    for (const condition of input.conditions) {
      children.push(new Paragraph({ text: condition, bullet: { level: 0 } }));
    }
  }

  children.push(new Paragraph({ text: "Source References", heading: HeadingLevel.HEADING_1 }));
  for (const citation of input.citations) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${citation.id}. `, bold: true }),
          new TextRun({ text: `${citation.title} — ` }),
          new TextRun({ text: citation.source, italics: true }),
          ...(citation.locator ? [new TextRun({ text: ` (${citation.locator})`, italics: true })] : []),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Generated from cited on-premise evidence. Human review and approval are required before use.",
          bold: true,
        }),
      ],
    }),
  );

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}
