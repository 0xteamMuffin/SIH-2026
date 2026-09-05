/**
 * Generates a folder of realistic demo documents for exercising the preview
 * viewers by hand.
 *
 * These are deliberately generated rather than committed as binaries: the
 * content stays reviewable in source, and every file is synthetic, so nothing
 * resembling real plant data ends up in the repository.
 *
 * Run with `npm run demo:docs`, then attach the files with the + button.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import { buildDocx, bullet, heading, paragraph, table } from "./lib/docx-writer.mjs";
import { Bitmap } from "./lib/png-writer.mjs";
import { buildPdf } from "./lib/pdf-writer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "demo-docs");

const ORANGE = [249, 115, 22];
const SLATE = [82, 82, 91];
const GRID = [228, 228, 231];

/** Every file, with the viewer behaviour it is meant to show off. */
const documents = [
  { name: "inspection-report.pdf", build: inspectionReport, shows: "multi-page PDF, text and rules" },
  { name: "deviation-log.xlsx", build: deviationLog, shows: "multi-sheet tabs, formulas, dates" },
  { name: "sensor-readings.csv", build: sensorReadings, shows: "CSV with quoted commas" },
  { name: "approval-note.docx", build: approvalNote, shows: "headings, body text, a table" },
  { name: "throughput-chart.png", build: throughputChart, shows: "image decoding" },
  { name: "quality_pipeline.py", build: qualityPipeline, shows: "source text" },
  { name: "batch-export.xlsx", build: batchExport, shows: "row cap — 'first 2,000 of 3,000 rows'" },
  { name: "unsupported-archive.7z", build: unsupportedArchive, shows: "honest 'no preview' card" },
];

async function main() {
  await mkdir(outputDirectory, { recursive: true });

  console.log(`\nWriting demo documents to ${outputDirectory}\n`);
  for (const { name, build, shows } of documents) {
    const data = await build();
    await writeFile(join(outputDirectory, name), data);
    console.log(`  ${name.padEnd(26)} ${formatBytes(data.length).padStart(9)}   ${shows}`);
  }

  console.log("\nAttach them with the + button in the composer, then press Preview.\n");
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

function inspectionReport() {
  const blocks = [
    { text: "PIPELINE INTEGRITY INSPECTION REPORT", size: 15, font: "F2", gapAfter: 4 },
    { text: "Unit 4 — Crude Distillation | Report QA-2291", size: 10, gapAfter: 10 },
    { rule: true },

    { text: "1. Scope", size: 12, font: "F2", gapAfter: 4 },
    {
      text:
        "Ultrasonic wall-thickness survey of the overhead vapour line between " +
        "V-401 and E-412, covering 68 metres of 12-inch carbon steel pipework " +
        "and fourteen welded joints. The survey was carried out during the " +
        "scheduled January turnaround with the line depressurised and purged.",
      gapAfter: 10,
    },

    { text: "2. Method", size: 12, font: "F2", gapAfter: 4 },
    {
      text:
        "Readings were taken on a 500 mm grid using a calibrated digital " +
        "thickness gauge, with four circumferential points per station. " +
        "Calibration was verified against a step wedge at the start and end of " +
        "each shift. Surface preparation was by wire brush to bare metal at " +
        "every measurement point.",
      gapAfter: 10,
    },

    { text: "3. Findings", size: 12, font: "F2", gapAfter: 4 },
    {
      text:
        "Nominal wall thickness is 9.53 mm with a corrosion allowance of " +
        "3.00 mm, giving a retirement thickness of 6.53 mm. Of 136 measurement " +
        "stations, 129 returned readings within the expected band.",
      gapAfter: 6,
    },
    {
      text:
        "Station 41 recorded 6.81 mm, the lowest reading on the run. This sits " +
        "above the retirement thickness but below the 7.00 mm alert threshold, " +
        "and represents a loss rate of roughly 0.21 mm per year against the " +
        "2021 baseline survey.",
      gapAfter: 6,
    },
    {
      text:
        "Stations 42 through 46, immediately downstream of the elbow, show a " +
        "consistent thinning trend consistent with erosion-corrosion at the " +
        "flow turn. No through-wall defects, blistering, or weld cracking were " +
        "identified anywhere on the surveyed length.",
      gapAfter: 6,
    },
    {
      text:
        "External coating was found degraded across a 4 metre section near the " +
        "pipe support at station 44, with surface rust but no measurable " +
        "section loss beneath.",
      gapAfter: 10,
    },

    { text: "4. Recommendations", size: 12, font: "F2", gapAfter: 4 },
    {
      text:
        "a) Reduce the inspection interval for stations 41 to 46 from 48 months " +
        "to 24 months, with the next survey due January 2028.",
      gapAfter: 4,
    },
    {
      text:
        "b) Recoat the degraded 4 metre section at station 44 during the next " +
        "available outage window.",
      gapAfter: 4,
    },
    {
      text:
        "c) Review the upstream flow control setpoint. Sustained velocity above " +
        "the design figure is the most likely driver of the observed " +
        "erosion-corrosion pattern at the elbow.",
      gapAfter: 4,
    },
    {
      text:
        "d) No immediate repair or pressure derating is required. The line " +
        "remains fit for continued service at the current maximum allowable " +
        "operating pressure.",
      gapAfter: 12,
    },
    { rule: true },

    { text: "5. Measurement Summary", size: 12, font: "F2", gapAfter: 4 },
    {
      text:
        "Stations surveyed: 136. Within band: 129. Below alert threshold: 6. " +
        "Below retirement thickness: 0. Minimum reading: 6.81 mm at station 41. " +
        "Mean reading: 8.94 mm. Standard deviation: 0.42 mm.",
      gapAfter: 10,
    },

    { text: "6. Certification", size: 12, font: "F2", gapAfter: 4 },
    {
      text:
        "Survey performed by the plant NDT group under procedure NDT-UT-014 " +
        "revision 6. All technicians hold current Level II ultrasonic " +
        "certification. Raw readings are retained in the integrity management " +
        "system under record QA-2291-RAW.",
      gapAfter: 6,
    },
    {
      text:
        "This report contains synthetic data generated for demonstration " +
        "purposes and does not describe any real asset.",
      size: 9,
      gapAfter: 0,
    },
  ];

  return buildPdf(blocks).buffer;
}

// ─── Spreadsheets ────────────────────────────────────────────────────────────

async function deviationLog() {
  const workbook = new ExcelJS.Workbook();

  const deviations = workbook.addWorksheet("Deviations");
  deviations.addRow(["Ref", "Raised", "Area", "Severity", "Description", "Status"]);
  const rows = [
    ["DEV-114", Date.UTC(2026, 0, 12), "Unit 4", "Major", "Wall loss at station 41 below alert threshold", "Closed"],
    ["DEV-115", Date.UTC(2026, 0, 14), "Unit 4", "Minor", "Coating degradation at pipe support", "Open"],
    ["DEV-116", Date.UTC(2026, 0, 19), "Unit 2", "Minor", "Gauge calibration record missing for shift B", "Closed"],
    ["DEV-117", Date.UTC(2026, 0, 23), "Unit 7", "Major", "Relief valve set pressure outside tolerance", "Open"],
    ["DEV-118", Date.UTC(2026, 1, 2), "Unit 4", "Observation", "Access scaffold obstructing station 52", "Closed"],
    ["DEV-119", Date.UTC(2026, 1, 8), "Tank Farm", "Minor", "Bund drain valve found open during round", "Closed"],
    ["DEV-120", Date.UTC(2026, 1, 15), "Unit 2", "Critical", "Interlock bypass left active after maintenance", "Escalated"],
  ];
  for (const [ref, raised, area, severity, description, status] of rows) {
    deviations.addRow([ref, new Date(raised), area, severity, description, status]);
  }

  const readings = workbook.addWorksheet("Thickness");
  readings.addRow(["Station", "2021 (mm)", "2026 (mm)", "Loss (mm)", "Rate (mm/yr)"]);
  const stations = [
    [40, 9.41, 8.02],
    [41, 9.38, 6.81],
    [42, 9.44, 7.12],
    [43, 9.4, 7.35],
    [44, 9.46, 7.58],
    [45, 9.39, 7.81],
    [46, 9.42, 8.19],
  ];
  stations.forEach(([station, before, after], index) => {
    const row = index + 2;
    readings.addRow([station, before, after]);
    // Real formulas, so the viewer's "show the computed result" path is
    // exercised rather than just literal values.
    readings.getCell(`D${row}`).value = { formula: `B${row}-C${row}`, result: Number((before - after).toFixed(2)) };
    readings.getCell(`E${row}`).value = {
      formula: `D${row}/5`,
      result: Number(((before - after) / 5).toFixed(3)),
    };
  });
  const summaryRow = stations.length + 2;
  readings.getCell(`A${summaryRow}`).value = "Minimum";
  readings.getCell(`C${summaryRow}`).value = { formula: `MIN(C2:C${summaryRow - 1})`, result: 6.81 };

  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["All figures synthetic. Generated for preview demonstration."]);
  notes.addRow(["Retirement thickness 6.53 mm; alert threshold 7.00 mm."]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Deliberately over the 2 000-row preview cap, to show the truncation note. */
async function batchExport() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Batches");
  sheet.addRow(["Batch", "Timestamp", "Temperature (C)", "Pressure (bar)", "Yield (%)"]);

  for (let index = 1; index <= 3000; index += 1) {
    sheet.addRow([
      `B-${String(index).padStart(5, "0")}`,
      new Date(Date.UTC(2026, 0, 1, 0, index % 1440)),
      Number((180 + Math.sin(index / 7) * 12).toFixed(1)),
      Number((4.2 + Math.cos(index / 11) * 0.4).toFixed(2)),
      Number((92 + Math.sin(index / 23) * 3).toFixed(1)),
    ]);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function sensorReadings() {
  const lines = [
    "station,timestamp,thickness_mm,technician,note",
    '41,2026-01-12T08:14:00Z,6.81,R. Nair,"Lowest reading, below alert threshold"',
    '42,2026-01-12T08:31:00Z,7.12,R. Nair,"Downstream of elbow, thinning trend"',
    "43,2026-01-12T08:47:00Z,7.35,R. Nair,Within band",
    '44,2026-01-12T09:05:00Z,7.58,S. Iyer,"Coating degraded, no section loss"',
    "45,2026-01-12T09:22:00Z,7.81,S. Iyer,Within band",
    '46,2026-01-12T09:40:00Z,8.19,S. Iyer,"Trend recovers, elbow effect ends"',
    '47,2026-01-12T09:58:00Z,8.94,S. Iyer,"Nominal, no action"',
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

// ─── Word ────────────────────────────────────────────────────────────────────

function approvalNote() {
  return buildDocx([
    heading("Approval Note — Continued Service, Unit 4 Overhead Vapour Line", 1),
    paragraph("Reference: QA-2291 | Prepared: 12 February 2026 | Classification: Internal", {
      size: 9,
      color: "666666",
    }),

    heading("Recommendation", 2),
    paragraph(
      "Approval is sought to return the Unit 4 overhead vapour line to service at " +
        "its current maximum allowable operating pressure, with a reduced inspection " +
        "interval applied to stations 41 through 46.",
    ),

    heading("Basis", 2),
    paragraph(
      "The January ultrasonic survey covered 136 measurement stations across 68 " +
        "metres of 12-inch carbon steel pipework. No reading fell below the 6.53 mm " +
        "retirement thickness, and no through-wall defects or weld cracking were found.",
    ),
    bullet("Minimum reading 6.81 mm at station 41, above retirement thickness."),
    bullet("Six stations below the 7.00 mm alert threshold, all downstream of the elbow."),
    bullet("Observed loss rate approximately 0.21 mm per year against the 2021 baseline."),
    bullet("External coating degraded over 4 metres at station 44, no section loss beneath."),

    heading("Thickness Summary", 2),
    table([
      ["Station", "2021 (mm)", "2026 (mm)", "Loss (mm)", "Assessment"],
      ["41", "9.38", "6.81", "2.57", "Below alert"],
      ["42", "9.44", "7.12", "2.32", "Below alert"],
      ["44", "9.46", "7.58", "1.88", "Below alert"],
      ["46", "9.42", "8.19", "1.23", "Within band"],
    ]),
    paragraph(""),

    heading("Conditions", 2),
    paragraph(
      "Approval is conditional on the inspection interval for stations 41 to 46 " +
        "being reduced from 48 to 24 months, recoating of the degraded section at " +
        "the next outage, and a review of the upstream flow control setpoint to " +
        "address the likely erosion-corrosion driver.",
    ),

    heading("Sign-off", 2),
    table(
      [
        ["Role", "Name", "Date"],
        ["Integrity Engineer", "", ""],
        ["Unit Manager", "", ""],
        ["Technical Authority", "", ""],
      ],
    ),
    paragraph(""),
    paragraph(
      "Synthetic content generated for demonstration. Does not describe a real asset " +
        "or constitute an engineering assessment.",
      { size: 8, color: "888888" },
    ),
  ]);
}

// ─── Image ───────────────────────────────────────────────────────────────────

/** A bar chart of remaining wall thickness by station. */
function throughputChart() {
  const width = 720;
  const height = 380;
  const chart = new Bitmap(width, height, [255, 255, 255]);

  const plotLeft = 70;
  const plotTop = 50;
  const plotBottom = height - 60;
  const plotRight = width - 40;
  const plotHeight = plotBottom - plotTop;

  // Horizontal gridlines every 2 mm across a 0–10 mm scale.
  for (let value = 0; value <= 10; value += 2) {
    const y = plotBottom - (value / 10) * plotHeight;
    chart.fillRect(plotLeft, y, plotRight - plotLeft, 1, GRID);
  }

  const readings = [
    ["40", 8.02],
    ["41", 6.81],
    ["42", 7.12],
    ["43", 7.35],
    ["44", 7.58],
    ["45", 7.81],
    ["46", 8.19],
  ];

  const slotWidth = (plotRight - plotLeft) / readings.length;
  const barWidth = slotWidth * 0.55;

  readings.forEach(([, value], index) => {
    const barHeight = (value / 10) * plotHeight;
    const x = plotLeft + index * slotWidth + (slotWidth - barWidth) / 2;
    chart.fillRect(x, plotBottom - barHeight, barWidth, barHeight, ORANGE);
  });

  // Retirement thickness line at 6.53 mm, drawn as a dashed rule.
  const retirementY = plotBottom - (6.53 / 10) * plotHeight;
  for (let x = plotLeft; x < plotRight; x += 12) {
    chart.fillRect(x, retirementY, 7, 2, [220, 38, 38]);
  }

  // Axes.
  chart.fillRect(plotLeft, plotTop, 2, plotHeight, SLATE);
  chart.fillRect(plotLeft, plotBottom, plotRight - plotLeft, 2, SLATE);

  return chart.toPng();
}

// ─── Text ────────────────────────────────────────────────────────────────────

function qualityPipeline() {
  return Buffer.from(
    `"""Wall-thickness screening for the Unit 4 overhead vapour line.

Synthetic demonstration code. Not used in production.
"""

import statistics

RETIREMENT_THICKNESS_MM = 6.53
ALERT_THRESHOLD_MM = 7.00

# The probe reports unstable values for its first few cycles after power-on.
WARMUP_SAMPLES = 5


def moving_average(samples, window=8):
    if not samples:
        return []
    out = []
    for index in range(len(samples)):
        chunk = samples[max(0, index - window + 1) : index + 1]
        out.append(statistics.fmean(chunk))
    return out


def screen(readings, threshold=ALERT_THRESHOLD_MM):
    """Return stations breaching the alert threshold.

    Warm-up samples are skipped rather than averaged in, because they would
    otherwise drag the early window down and mask a real breach.
    """
    if len(readings) <= WARMUP_SAMPLES:
        return []

    averaged = moving_average(readings[WARMUP_SAMPLES:])
    return [
        index + WARMUP_SAMPLES
        for index, value in enumerate(averaged)
        if value < threshold
    ]


def retirement_breaches(readings):
    return [i for i, value in enumerate(readings) if value < RETIREMENT_THICKNESS_MM]
`,
    "utf8",
  );
}

// ─── Unsupported ─────────────────────────────────────────────────────────────

/**
 * Not a real archive — it exists only so the "no preview for this file type"
 * card can be seen. The viewer never reads its bytes.
 */
function unsupportedArchive() {
  return Buffer.from("7z\xBC\xAF\x27\x1C placeholder for the unsupported-format card", "latin1");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

await main();
