import { useEffect, useRef, useState, type FormEvent } from "react";

import type { SessionState } from "@shared/types.js";

/** Where the backend usually lives during development. */
const DEFAULT_BASE_URL = "http://localhost:4000";

export interface SignInProps {
  session: SessionState;
  onConnect: (baseUrl: string, email: string, password: string) => Promise<void>;
}

/**
 * Sign-in gate.
 *
 * The workbench has no offline mode by design: every answer comes from the
 * on-premise backend, so there is nothing useful to show before a connection
 * exists. Credentials go straight to main and are never held here.
 */
export function SignIn({ session, onConnect }: SignInProps): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(session.baseUrl || DEFAULT_BASE_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const prefilled = useRef(false);

  // Session state resolves after this mounts, so the development prefill is
  // applied when it arrives rather than in the initialisers. Applied once, so
  // it never overwrites what someone has started typing.
  const prefill = session.prefill;
  useEffect(() => {
    if (!prefill || prefilled.current) return;
    prefilled.current = true;
    setBaseUrl(prefill.baseUrl);
    setEmail(prefill.email);
    setPassword(prefill.password);
  }, [prefill]);

  const isConnecting = session.status === "connecting";
  const canSubmit = baseUrl.trim() && email.trim() && password && !isConnecting;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSubmit) return;
    void onConnect(baseUrl.trim(), email.trim(), password);
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={handleSubmit}>
        <h1 className="signin__title">Sovereign Workbench</h1>
        <p className="signin__subtitle">Connect to your on-premise deployment.</p>

        <label className="signin__field">
          <span>Backend address</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_BASE_URL}
            spellCheck={false}
            autoComplete="url"
          />
        </label>

        <label className="signin__field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>

        <label className="signin__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>

        {session.error && (
          <p className="signin__error" role="alert">
            {session.error}
          </p>
        )}

        <button type="submit" className="signin__submit" disabled={!canSubmit}>
          {isConnecting ? "Connecting…" : "Connect"}
        </button>

        {session.prefill && (
          <p className="signin__note signin__note--dev">
            Prefilled from the repository&rsquo;s <code>.env</code> for development. Packaged builds
            open empty.
          </p>
        )}

        <p className="signin__note">
          Credentials are sent only to the address above and are not stored on this machine.
        </p>
      </form>
    </div>
  );
}
