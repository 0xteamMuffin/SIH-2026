import { useMemo } from "react";

import { useDocumentBytes } from "../../hooks/useDocumentBytes.js";
import { PreviewError, PreviewLoading, PreviewNote } from "./PreviewState.js";
import type { DocumentViewerProps } from "./registry.js";

/** Characters shown before truncating — enough for any human review pass. */
const MAX_CHARACTERS = 200_000;

export function TextViewer({ document }: DocumentViewerProps): React.JSX.Element {
  const { data: bytes, isLoading, error } = useDocumentBytes(document);

  const decoded = useMemo(() => {
    if (!bytes) return null;
    // `fatal: false` means undecodable bytes become replacement characters
    // rather than throwing — a mislabelled file should still be readable.
    const text = new TextDecoder("utf-8").decode(bytes);
    return { text: text.slice(0, MAX_CHARACTERS), truncated: text.length > MAX_CHARACTERS };
  }, [bytes]);

  if (isLoading) return <PreviewLoading label="Reading file…" />;
  if (error) return <PreviewError message={error} />;
  if (!decoded) return <PreviewError message="Nothing to show." />;

  return (
    <div className="textfile">
      <pre className="textfile__body">{decoded.text}</pre>
      {decoded.truncated && (
        <PreviewNote>Truncated to the first {MAX_CHARACTERS.toLocaleString()} characters.</PreviewNote>
      )}
    </div>
  );
}
