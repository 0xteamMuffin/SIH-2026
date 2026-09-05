import { useCallback, useEffect, useState } from "react";

import { DISCONNECTED_SESSION, type SessionState } from "@shared/types.js";

export interface SessionController {
  session: SessionState;
  isReady: boolean;
  connect: (baseUrl: string, email: string, password: string) => Promise<void>;
  disconnect: () => void;
  selectWorkspace: (workspaceId: string) => void;
}

/**
 * Tracks the backend connection.
 *
 * State is owned by the main process — it holds the tokens — so this only
 * mirrors what main publishes and never derives connection status locally.
 */
export function useSession(): SessionController {
  const [session, setSession] = useState<SessionState>(DISCONNECTED_SESSION);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    window.workbench.session
      .state()
      .then(setSession)
      .catch((error: unknown) => console.error("[session] could not read state", error))
      .finally(() => setIsReady(true));
  }, []);

  useEffect(
    () =>
      window.workbench.onEvent((event) => {
        if (event.type === "session/changed") setSession(event.state);
      }),
    [],
  );

  const connect = useCallback(async (baseUrl: string, email: string, password: string) => {
    // The result also arrives as an event; awaiting it here lets the caller
    // keep a submit button disabled for the duration.
    setSession(await window.workbench.session.connect(baseUrl, email, password));
  }, []);

  return {
    session,
    isReady,
    connect,
    disconnect: useCallback(() => {
      void window.workbench.session.disconnect().then(setSession);
    }, []),
    selectWorkspace: useCallback((workspaceId: string) => {
      void window.workbench.session.selectWorkspace(workspaceId).then(setSession);
    }, []),
  };
}
