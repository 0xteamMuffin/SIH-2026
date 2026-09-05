import type { MessageBlock } from "@shared/types.js";

import type { AgentGateway, AgentTurnRequest } from "./agent-gateway.js";
import { buildFilePatch } from "./diff.js";

/** Pause between scripted steps, so streaming behaviour is visible in the UI. */
const STEP_DELAY_MS = 550;

/**
 * A stand-in `AgentGateway` that replays canned turns.
 *
 * Its only job is to exercise every `MessageBlock` kind so the chat UI, the
 * diff renderer, the preview cards, and the browser pane can be built and
 * reviewed before the on-prem backend exists. It performs no inference, reads
 * no files, and reaches no network.
 *
 * Replace with the real HTTP-backed gateway; delete this file at that point.
 */
export class ScriptedAgentGateway implements AgentGateway {
  async runTurn({ prompt, signal, publish }: AgentTurnRequest): Promise<void> {
    const blocks: MessageBlock[] = [
      { kind: "status", state: "running", label: "Planning" },
    ];
    publish(blocks);

    for (const step of selectScript(prompt)) {
      await delay(STEP_DELAY_MS, signal);
      if (signal.aborted) {
        publish([...blocks.slice(0, -1), { kind: "status", state: "cancelled", label: "Stopped" }]);
        return;
      }
      // The trailing status block is transient: each step replaces it, so the
      // thread shows one live indicator rather than a pile of stale ones.
      blocks.splice(blocks.length - 1, 1, ...step);
      publish(blocks);
    }

    // Replace, not append: the final step left its own live status block
    // trailing, and pushing here would leave two indicators on screen.
    blocks.splice(blocks.length - 1, 1, { kind: "status", state: "completed", label: "Done" });
    publish(blocks);
  }
}

/** Each entry replaces the live status block with content plus a new status. */
type ScriptStep = MessageBlock[];

function selectScript(prompt: string): ScriptStep[] {
  const normalised = prompt.toLowerCase();

  if (/\bhttps?:\/\/|\bbrowse\b|\bopen\b.*\bsite\b|\bweb\b/.test(normalised)) {
    return browsingScript(prompt);
  }
  if (/\bpdf\b|\bexcel\b|\bxlsx\b|\bspreadsheet\b|\bdocx?\b|\breport\b|\bpreview\b/.test(normalised)) {
    return documentScript();
  }
  if (/\bfix\b|\bdiff\b|\bpatch\b|\brefactor\b|\bchange\b|\bcode\b|\bthreshold\b/.test(normalised)) {
    return codeChangeScript();
  }
  return explanationScript();
}

function codeChangeScript(): ScriptStep[] {
  return [
    [
      { kind: "text", text: "Reading `pipeline/quality.py` from the workspace volume." },
      { kind: "status", state: "running", label: "Editing 1 file" },
    ],
    [
      {
        kind: "text",
        text:
          "The alarm threshold was hardcoded and the moving average ignored the " +
          "sensor's warm-up window. I widened the window and made the threshold " +
          "configurable:",
      },
      {
        kind: "diff",
        patch: buildFilePatch({
          path: "pipeline/quality.py",
          before: SAMPLE_BEFORE,
          after: SAMPLE_AFTER,
        }),
      },
      { kind: "status", state: "running", label: "Verifying" },
    ],
    [
      {
        kind: "text",
        text:
          "Unit tests pass against the recorded batch. The change is staged in the " +
          "workspace and not yet committed.",
      },
      { kind: "status", state: "running", label: "Finishing" },
    ],
  ];
}

function documentScript(): ScriptStep[] {
  return [
    [
      { kind: "text", text: "Fetching the artifact from object storage." },
      { kind: "status", state: "running", label: "Reading document" },
    ],
    [
      {
        kind: "text",
        text: "Here is the batch record you asked about, plus the summary I generated:",
      },
      {
        kind: "document",
        document: {
          id: "demo-batch-record",
          filename: "batch-record-QA-2291.pdf",
          mimeType: "application/pdf",
          kind: "pdf",
          byteSize: 481_233,
          source: { type: "artifact", artifactId: "demo-batch-record" },
        },
      },
      {
        kind: "document",
        document: {
          id: "demo-deviation-log",
          filename: "deviation-log.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          kind: "spreadsheet",
          byteSize: 22_940,
          source: { type: "artifact", artifactId: "demo-deviation-log" },
        },
      },
      { kind: "status", state: "running", label: "Summarising" },
    ],
  ];
}

function browsingScript(prompt: string): ScriptStep[] {
  const url = extractUrl(prompt) ?? "https://www.electronjs.org/docs/latest/api/web-contents-view";
  return [
    [
      { kind: "text", text: `Opening ${url} in the embedded browser.` },
      { kind: "status", state: "running", label: "Navigating" },
    ],
    [
      { kind: "text", text: "The page is open in the browser pane — I can read it from there." },
      { kind: "browser", url },
      { kind: "status", state: "running", label: "Reading page" },
    ],
  ];
}

function explanationScript(): ScriptStep[] {
  return [
    [
      { kind: "status", state: "running", label: "Thinking" },
    ],
    [
      {
        kind: "text",
        text: [
          "I am the scripted stand-in agent. No model is wired up yet, so I replay",
          "fixed answers to prove out the interface.",
          "",
          "Things worth trying:",
          "",
          "- ask me to **fix a threshold** or **refactor** something — you get a red/green diff",
          "- mention a **PDF** or **spreadsheet** — you get inline document cards",
          "- paste a **URL** — it opens in the embedded browser pane",
        ].join("\n"),
      },
      { kind: "status", state: "running", label: "Finishing" },
    ],
  ];
}

function extractUrl(prompt: string): string | null {
  return /\bhttps?:\/\/[^\s<>"')]+/i.exec(prompt)?.[0] ?? null;
}

/** Resolves after `ms`, or immediately once `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

const SAMPLE_BEFORE = `import statistics


ALARM_THRESHOLD = 0.82


def moving_average(samples, window=3):
    if not samples:
        return []
    out = []
    for index in range(len(samples)):
        chunk = samples[max(0, index - window + 1) : index + 1]
        out.append(statistics.fmean(chunk))
    return out


def flag_batches(readings):
    """Return the indices of batches that breach the alarm threshold."""
    averaged = moving_average(readings)
    return [i for i, value in enumerate(averaged) if value > ALARM_THRESHOLD]
`;

const SAMPLE_AFTER = `import statistics


DEFAULT_ALARM_THRESHOLD = 0.82

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


def flag_batches(readings, threshold=DEFAULT_ALARM_THRESHOLD):
    """Return the indices of batches that breach the alarm threshold.

    Warm-up samples are skipped rather than averaged in, because they would
    otherwise drag the early window below the threshold and mask a real breach.
    """
    if len(readings) <= WARMUP_SAMPLES:
        return []

    averaged = moving_average(readings[WARMUP_SAMPLES:])
    return [i + WARMUP_SAMPLES for i, value in enumerate(averaged) if value > threshold]
`;
