import { useState } from "react";

import type { DiffHunk, DiffLine, FilePatch } from "@shared/types.js";

import { Icon } from "../ui/Icon.js";

const CHANGE_LABELS: Record<FilePatch["changeType"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

/** Change type carries the same colour language as the rows below it. */
const CHANGE_TONE: Record<FilePatch["changeType"], string> = {
  added: "badge--success",
  modified: "badge--neutral",
  deleted: "badge--danger",
  renamed: "badge--info",
};

/**
 * A unified diff for one file, in the red/green style of a pull request.
 *
 * Renders straight from a `FilePatch` and computes nothing: line numbers,
 * additions, and deletions are all resolved upstream, so this stays a pure
 * view whether the patch was built locally or handed over by the backend.
 */
export function DiffView({ patch }: { patch: FilePatch }): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <figure className={`diff ${isCollapsed ? "diff--collapsed" : ""}`}>
      <button
        type="button"
        className="diff__header"
        onClick={() => setIsCollapsed((collapsed) => !collapsed)}
        aria-expanded={!isCollapsed}
      >
        <Icon
          name="chevron-down"
          size={13}
          className={`diff__chevron ${isCollapsed ? "diff__chevron--collapsed" : ""}`}
        />

        <span className="diff__path">
          {patch.previousPath && (
            <span className="diff__previous-path">{patch.previousPath} → </span>
          )}
          {patch.path}
        </span>

        <span className={`badge ${CHANGE_TONE[patch.changeType]}`}>
          {CHANGE_LABELS[patch.changeType]}
        </span>

        <span className="diff__stats">
          {patch.additions > 0 && <span className="diff__stat--add">+{patch.additions}</span>}
          {patch.deletions > 0 && <span className="diff__stat--del">−{patch.deletions}</span>}
        </span>
      </button>

      {!isCollapsed && (
        <div className="diff__body selectable">
          {patch.binary ? (
            <p className="diff__empty">Binary file — no textual diff.</p>
          ) : patch.hunks.length === 0 ? (
            <p className="diff__empty">No changes.</p>
          ) : (
            patch.hunks.map((hunk, index) => (
              <HunkView key={`${hunk.oldStart}-${hunk.newStart}-${index}`} hunk={hunk} />
            ))
          )}
        </div>
      )}
    </figure>
  );
}

function HunkView({ hunk }: { hunk: DiffHunk }): React.JSX.Element {
  return (
    <table className="diff__table">
      <caption className="diff__hunk-header">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </caption>
      <tbody>
        {hunk.lines.map((line, index) => (
          <LineView key={index} line={line} />
        ))}
      </tbody>
    </table>
  );
}

const LINE_MARKERS: Record<DiffLine["type"], string> = {
  add: "+",
  del: "−",
  context: " ",
};

function LineView({ line }: { line: DiffLine }): React.JSX.Element {
  return (
    <tr className={`diff__line diff__line--${line.type}`}>
      <td className="diff__gutter" aria-hidden={line.oldNumber === null}>
        {line.oldNumber ?? ""}
      </td>
      <td className="diff__gutter" aria-hidden={line.newNumber === null}>
        {line.newNumber ?? ""}
      </td>
      <td className="diff__marker" aria-hidden="true">
        {LINE_MARKERS[line.type]}
      </td>
      {/* A zero-width space keeps blank lines from collapsing to no height. */}
      <td className="diff__code">{line.content || "​"}</td>
    </tr>
  );
}
