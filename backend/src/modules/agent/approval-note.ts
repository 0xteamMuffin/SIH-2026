import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import type { EvidenceItem } from "./agent.types.js";

export async function approvalNoteDocx(task: string, evidence: EvidenceItem[]) {
  const findings = evidence.flatMap((item) => item.facts.map((fact) => new Paragraph({ text: fact, bullet: { level: 0 } })));
  const references = evidence.map((item) => new Paragraph({ children: [new TextRun({ text: `${item.title}: ${item.sourceRef}`, italics: true })] }));
  const document = new Document({ sections: [{ children: [
    new Paragraph({ text: "Approval Note", heading: HeadingLevel.TITLE }),
    new Paragraph({ text: "Purpose", heading: HeadingLevel.HEADING_1 }),
    new Paragraph(task),
    new Paragraph({ text: "Key Findings", heading: HeadingLevel.HEADING_1 }),
    ...(findings.length ? findings : [new Paragraph("No verifiable findings were extracted.")]),
    new Paragraph({ text: "Source References", heading: HeadingLevel.HEADING_1 }),
    ...references,
    new Paragraph({ children: [new TextRun({ text: "This draft was generated from the cited on-premise evidence. Human review and approval are required before use.", bold: true })] }),
  ] }] });
  return Packer.toBuffer(document);
}
