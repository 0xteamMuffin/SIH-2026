import { useCallback, useEffect, useState } from "react";

export interface RemoteResource<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  /** Re-fetches. Keeps the last value on screen while the new one arrives. */
  reload: () => void;
}

/**
 * Loads something over IPC and tracks the three states every governance view
 * needs to show honestly: loading, failed, and loaded.
 *
 * The previous value is kept during a reload rather than blanking the screen.
 * These views are refreshed while someone is reading them, and a table that
 * empties for a moment on every refresh reads as "the data is gone".
 *
 * `key` is what identifies the request. `load` is a fresh closure on every
 * render, so depending on it would refetch in a loop.
 */
export function useRemoteResource<T>(load: () => Promise<T>, key: string): RemoteResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return { data, error, isLoading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * True when a failure was the backend refusing on authorisation grounds.
 *
 * Worth distinguishing: "you are not an administrator" is a normal answer for
 * an operator opening a governance view, and showing it as an error would
 * imply something is broken.
 */
export function isAuthorisationFailure(message: string | null): boolean {
  if (!message) return false;
  return /insufficient role|forbidden|access denied/i.test(message);
}
