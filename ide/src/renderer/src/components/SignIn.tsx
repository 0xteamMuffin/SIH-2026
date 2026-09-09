import { useEffect, useRef, useState, type FormEvent } from "react";

import type { SessionState } from "@shared/types.js";

import { Icon, type IconName } from "./ui/Icon.js";

/** Where the backend usually lives during development. */
const DEFAULT_BASE_URL = "http://localhost:4000";

interface Point {
  icon: IconName;
  title: string;
  body: string;
}

/**
 * What the left column says.
 *
 * These are the three properties that make this a sovereign workbench rather
 * than another chat client, and they are the questions someone deploying it
 * has to be able to answer before they sign in.
 */
const POINTS: readonly Point[] = [
  {
    icon: "lock",
    title: "Nothing leaves the cluster",
    body: "Documents, prompts, and results stay inside your deployment.",
  },
  {
    icon: "cpu",
    title: "Routing you can inspect",
    body: "Every turn records which model answered and why.",
  },
  {
    icon: "shield",
    title: "Human approval on risk",
    body: "High-risk tools suspend the run until someone signs off.",
  },
];

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
  const canSubmit = Boolean(baseUrl.trim() && email.trim() && password) && !isConnecting;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSubmit) return;
    void onConnect(baseUrl.trim(), email.trim(), password);
  }

  return (
    <div className="signin">
      <aside className="signin__aside">
        <div className="signin__brand">
          <span className="signin__brand-mark">
            <Icon name="shield" size={18} strokeWidth={1.9} />
          </span>
          <span className="signin__brand-name">Sovereign Workbench</span>
        </div>

        <div className="signin__pitch">
          <h1 className="signin__headline">An agent that works where your data already lives.</h1>
          <p className="signin__lede">
            Read the documents, build the workbook, run the script — on your own hardware, with
            every step recorded.
          </p>

          <ul className="signin__points">
            {POINTS.map((point) => (
              <li key={point.title} className="signin__point">
                <span className="signin__point-icon">
                  <Icon name={point.icon} size={13} />
                </span>
                <span>
                  <span className="signin__point-title">{point.title}</span>
                  <br />
                  <span className="signin__point-body">{point.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="signin__footnote">On-premise deployment · No external inference</p>
      </aside>

      <div className="signin__panel">
        <form className="signin__form" onSubmit={handleSubmit}>
          <h2 className="signin__title">Connect</h2>
          <p className="signin__subtitle">Sign in to your deployment to start working.</p>

          <label className="signin__field">
            <span className="signin__label">Backend address</span>
            <input
              className="field"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_BASE_URL}
              spellCheck={false}
              autoComplete="url"
            />
          </label>

          <label className="signin__field">
            <span className="signin__label">Email</span>
            <input
              className="field"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>

          <label className="signin__field">
            <span className="signin__label">Password</span>
            <input
              className="field"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>

          {session.error && (
            <p className="signin__error" role="alert">
              <Icon name="alert-circle" size={14} />
              <span>{session.error}</span>
            </p>
          )}

          <button
            type="submit"
            className="btn btn--primary btn--lg btn--block signin__submit"
            disabled={!canSubmit}
          >
            {isConnecting ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Connecting…
              </>
            ) : (
              "Connect"
            )}
          </button>

          {session.prefill && (
            <p className="signin__note signin__note--dev">
              <Icon name="alert-circle" size={13} />
              <span>
                Prefilled from the repository&rsquo;s <code>.env</code> for development. Packaged
                builds open empty.
              </span>
            </p>
          )}

          <p className="signin__note">
            Credentials are sent only to the address above and are not stored on this machine.
          </p>
        </form>
      </div>
    </div>
  );
}
