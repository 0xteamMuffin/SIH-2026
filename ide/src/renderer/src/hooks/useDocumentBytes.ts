import { useEffect, useState } from "react";

import type { DocumentRef } from "@shared/types.js";

export interface AsyncResource<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches a document's bytes from the main process.
 *
 * Only `file` sources resolve today. An `artifact` source needs the backend's
 * object-storage route, so it reports that plainly rather than hanging or
 * rendering an empty viewer.
 */
export function useDocumentBytes(document: DocumentRef): AsyncResource<ArrayBuffer> {
  return useDocumentResource(document, (documentId) => window.workbench.documents.read(documentId));
}

/**
 * Shared loader for anything keyed off a document id. Guards against the
 * document changing mid-flight, so a slow read cannot overwrite a newer one.
 */
export function useDocumentResource<T>(
  document: DocumentRef,
  load: (documentId: string) => Promise<T>,
): AsyncResource<T> {
  const [state, setState] = useState<AsyncResource<T>>({
    data: null,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    if (document.source.type !== "file") {
      setState({
        data: null,
        isLoading: false,
        error: "Reading stored artifacts needs the backend, which is not connected yet.",
      });
      return;
    }

    let cancelled = false;
    setState({ data: null, isLoading: true, error: null });

    load(document.id)
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          isLoading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });

    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure each render; the document id is what actually
    // identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, document.source.type]);

  return state;
}
