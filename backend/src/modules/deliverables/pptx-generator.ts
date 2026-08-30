import PptxGenJS from "pptxgenjs";
import { HUMAN_REVIEW_NOTICE, pptxDeliverableInputSchema, type PptxDeliverableInput } from "./deliverable-schemas.js";

export const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export { HUMAN_REVIEW_NOTICE };

const COLOR = {
  ink: "132A3A",
  steel: "2F6173",
  orange: "E87722",
  paper: "F4F6F5",
  white: "FFFFFF",
  muted: "667780",
  line: "CBD4D6",
  critical: "A61B1B",
  high: "D04A1B",
  medium: "C58B18",
  low: "39736A",
  info: "3C6E8F",
} as const;

type Presentation = import("pptxgenjs").default;
type Slide = ReturnType<Presentation["addSlide"]>;
const PresentationConstructor = PptxGenJS as unknown as new () => Presentation;

function addFrame(slide: Slide, sectionLabel: string, page: number) {
  slide.background = { color: COLOR.paper };
  slide.addShape("rect", { x: 0, y: 0, w: 13.333, h: 0.12, line: { transparency: 100 }, fill: { color: COLOR.orange } });
  slide.addText(sectionLabel.toUpperCase(), { x: 0.65, y: 0.25, w: 9, h: 0.28, fontFace: "Aptos", fontSize: 9, bold: true, color: COLOR.steel, charSpacing: 1.6, margin: 0 });
  slide.addShape("line", { x: 0.65, y: 6.98, w: 12.02, h: 0, line: { color: COLOR.line, width: 1 } });
  slide.addText(HUMAN_REVIEW_NOTICE, { x: 0.65, y: 7.08, w: 6.5, h: 0.2, fontFace: "Aptos", fontSize: 7.5, bold: true, color: COLOR.muted, margin: 0 });
  slide.addText(String(page).padStart(2, "0"), { x: 11.95, y: 7.05, w: 0.7, h: 0.22, fontFace: "Aptos", fontSize: 8, bold: true, color: COLOR.muted, align: "right", margin: 0 });
}

function addHeading(slide: Slide, title: string, kicker?: string) {
  if (kicker) slide.addText(kicker.toUpperCase(), { x: 0.65, y: 0.72, w: 11.8, h: 0.25, fontSize: 10, bold: true, color: COLOR.orange, charSpacing: 1.4, margin: 0 });
  slide.addText(title, { x: 0.65, y: kicker ? 1.05 : 0.78, w: 11.9, h: 0.72, fontFace: "Aptos Display", fontSize: 28, bold: true, color: COLOR.ink, breakLine: false, fit: "shrink", margin: 0 });
}

function addTitleSlide(pptx: Presentation, input: PptxDeliverableInput, page: number) {
  const slide = pptx.addSlide();
  slide.background = { color: COLOR.ink };
  slide.addShape("rect", { x: 0, y: 0, w: 0.24, h: 7.5, line: { transparency: 100 }, fill: { color: COLOR.orange } });
  slide.addText("INDUSTRIAL REVIEW PACK", { x: 0.85, y: 0.8, w: 5.5, h: 0.3, fontSize: 11, bold: true, color: "7FC0CC", charSpacing: 2.2, margin: 0 });
  slide.addText(input.title, { x: 0.85, y: 1.45, w: 10.8, h: 2.25, fontFace: "Aptos Display", fontSize: 34, bold: true, color: COLOR.white, breakLine: false, fit: "shrink", margin: 0 });
  if (input.subtitle) {
    slide.addText(input.subtitle, { x: 0.9, y: 4.0, w: 9.8, h: 0.85, fontSize: 18, color: "D8E4E6", fit: "shrink", margin: 0 });
  }
  slide.addShape("line", { x: 0.9, y: 5.52, w: 2.2, h: 0, line: { color: COLOR.orange, width: 4 } });
  slide.addText(`${input.sections.length} SECTIONS  /  ${input.citations.length} SOURCES`, { x: 0.9, y: 5.72, w: 6, h: 0.3, fontSize: 10, bold: true, color: "AFC2C7", charSpacing: 1.2, margin: 0 });
  slide.addText(HUMAN_REVIEW_NOTICE, { x: 0.9, y: 6.72, w: 8, h: 0.25, fontSize: 9, bold: true, color: COLOR.white, margin: 0 });
  slide.addText(String(page).padStart(2, "0"), { x: 11.9, y: 6.72, w: 0.65, h: 0.25, fontSize: 9, bold: true, color: "AFC2C7", align: "right", margin: 0 });
}

function severityColor(severity: PptxDeliverableInput["sections"][number]["findings"][number]["severity"]) {
  return COLOR[severity];
}

export async function generatePptx(input: PptxDeliverableInput): Promise<Buffer> {
  const value = pptxDeliverableInputSchema.parse(input);
  const pptx = new PresentationConstructor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "SIH Deliverable Generator";
  pptx.company = "SIH";
  pptx.subject = "Human-reviewed industrial findings with cited sources";
  pptx.title = value.title;
  pptx.revision = "1";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };

  let page = 1;
  addTitleSlide(pptx, value, page++);

  const agenda = pptx.addSlide();
  addFrame(agenda, "Review map", page++);
  addHeading(agenda, "Contents", "Evidence-led brief");
  value.sections.forEach((section, index) => {
    const column = index < 6 ? 0 : 1;
    const row = index % 6;
    const x = column === 0 ? 0.72 : 6.9;
    agenda.addText(String(index + 1).padStart(2, "0"), { x, y: 1.9 + row * 0.75, w: 0.45, h: 0.35, fontSize: 12, bold: true, color: COLOR.orange, margin: 0 });
    agenda.addText(section.title, { x: x + 0.55, y: 1.85 + row * 0.75, w: 5.05, h: 0.45, fontSize: 16, bold: true, color: COLOR.ink, fit: "shrink", margin: 0 });
    agenda.addText(`${section.findings.length} finding${section.findings.length === 1 ? "" : "s"}`, { x: x + 0.55, y: 2.27 + row * 0.75, w: 3, h: 0.18, fontSize: 8, color: COLOR.muted, margin: 0 });
  });

  value.sections.forEach((section, sectionIndex) => {
    const overview = pptx.addSlide();
    addFrame(overview, `Section ${sectionIndex + 1}`, page++);
    addHeading(overview, section.title, `${section.findings.length} evidence-backed findings`);
    overview.addShape("roundRect", { x: 0.65, y: 1.9, w: 8.2, h: 4.4, rectRadius: 0.08, line: { color: COLOR.line, width: 1 }, fill: { color: COLOR.white } });
    overview.addText("SECTION CONTEXT", { x: 0.95, y: 2.2, w: 3, h: 0.24, fontSize: 9, bold: true, color: COLOR.steel, charSpacing: 1.2, margin: 0 });
    overview.addText(section.summary, { x: 0.95, y: 2.65, w: 7.55, h: 3.1, fontSize: 19, color: COLOR.ink, breakLine: false, valign: "middle", fit: "shrink", margin: 0 });
    overview.addShape("rect", { x: 9.2, y: 1.9, w: 3.45, h: 4.4, line: { transparency: 100 }, fill: { color: COLOR.steel } });
    overview.addText(String(section.findings.length).padStart(2, "0"), { x: 9.55, y: 2.35, w: 2.75, h: 1.25, fontSize: 48, bold: true, color: COLOR.white, align: "center", margin: 0 });
    overview.addText("FINDINGS\nTO REVIEW", { x: 9.55, y: 3.8, w: 2.75, h: 0.9, fontSize: 14, bold: true, color: "DCEAEC", align: "center", breakLine: false, margin: 0 });

    section.findings.forEach((finding, findingIndex) => {
      const slide = pptx.addSlide();
      addFrame(slide, `${section.title} / Finding ${findingIndex + 1}`, page++);
      addHeading(slide, finding.title, `Finding ${String(findingIndex + 1).padStart(2, "0")}`);
      const severity = finding.severity.toUpperCase();
      slide.addShape("roundRect", { x: 10.65, y: 0.73, w: 1.95, h: 0.38, rectRadius: 0.08, line: { transparency: 100 }, fill: { color: severityColor(finding.severity) } });
      slide.addText(severity, { x: 10.65, y: 0.82, w: 1.95, h: 0.16, fontSize: 8.5, bold: true, color: COLOR.white, align: "center", charSpacing: 1, margin: 0 });
      slide.addShape("rect", { x: 0.65, y: 1.9, w: 0.13, h: 4.42, line: { transparency: 100 }, fill: { color: severityColor(finding.severity) } });
      slide.addShape("rect", { x: 0.78, y: 1.9, w: 11.87, h: 4.42, line: { color: COLOR.line, width: 1 }, fill: { color: COLOR.white } });
      slide.addText(finding.detail, { x: 1.18, y: 2.3, w: 10.95, h: 2.95, fontSize: 22, color: COLOR.ink, valign: "middle", fit: "shrink", margin: 0 });
      slide.addText("SOURCE REFERENCES", { x: 1.18, y: 5.55, w: 2.5, h: 0.2, fontSize: 8.5, bold: true, color: COLOR.steel, charSpacing: 1, margin: 0 });
      slide.addText(finding.citationIds.map((id) => `[${id}]`).join("  "), { x: 3.15, y: 5.51, w: 8.9, h: 0.3, fontFace: "Aptos", fontSize: 10, bold: true, color: COLOR.ink, fit: "shrink", margin: 0 });
      slide.addNotes(finding.citationIds.map((id) => {
        const citation = value.citations.find((item) => item.id === id)!;
        return `[${citation.id}] ${citation.title}: ${citation.source}${citation.locator ? ` (${citation.locator})` : ""}`;
      }).join("\n"));
    });
  });

  for (let index = 0; index < value.citations.length; index += 2) {
    const slide = pptx.addSlide();
    addFrame(slide, "Source register", page++);
    addHeading(slide, "Source references", `${index + 1}-${Math.min(index + 2, value.citations.length)} of ${value.citations.length}`);
    value.citations.slice(index, index + 2).forEach((citation, citationIndex) => {
      const y = 1.85 + citationIndex * 2.25;
      slide.addShape("roundRect", { x: 0.68, y, w: 11.95, h: 1.85, rectRadius: 0.06, line: { color: COLOR.line, width: 1 }, fill: { color: COLOR.white } });
      slide.addText(`[${citation.id}]`, { x: 0.98, y: y + 0.28, w: 1.3, h: 0.3, fontSize: 11, bold: true, color: COLOR.orange, margin: 0 });
      slide.addText(citation.title, { x: 2.15, y: y + 0.23, w: 9.9, h: 0.4, fontSize: 16, bold: true, color: COLOR.ink, fit: "shrink", margin: 0 });
      slide.addText(citation.source, { x: 2.15, y: y + 0.78, w: 9.9, h: 0.58, fontSize: 11.5, color: COLOR.steel, fit: "shrink", margin: 0 });
      if (citation.locator) slide.addText(citation.locator, { x: 2.15, y: y + 1.42, w: 9.9, h: 0.18, fontSize: 8.5, italic: true, color: COLOR.muted, margin: 0 });
    });
  }

  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  return Buffer.from(output as Uint8Array);
}
