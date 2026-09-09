import { useCallback, useState } from "react";

import type {
  EgressEntry,
  EgressLedger,
  EgressProbeResult,
  SovereigntyControl,
  SovereigntyControlState,
  SovereigntyPosture,
  SovereigntyProvider,
} from "@shared/types.js";

import { isAuthorisationFailure, useRemoteResource } from "../hooks/useRemoteResource.js";
import { Icon, type IconName } from "../components/ui/Icon.js";
import { IconButton } from "../components/ui/IconButton.js";

/**
 * The sovereignty view.
 *
 * The deployment's central claim is that confidential work never leaves the
 * premises. This screen is the evidence for it, in four parts: the verdict,
 * the controls actually in force, every destination the system is configured
 * to be able to reach, and the ledger of every call it has made.
 *
 * Two decisions shape the whole screen. First, calls to public providers are
 * shown rather than hidden — they are real, and a ledger that omitted them
 * would be worthless — but they are dimmed and tagged `DEV`, because
 * development scaffolding should never read as the product. Second, nothing
 * here is a claim in prose: every row is either backend-recorded fact or a
 * pointer to the file where a reviewer can confirm it.
 */

/** How many ledger rows to pull. Enough to cover a demo without paging. */
const LEDGER_LIMIT = 60;

const CONTROL_ICONS: Record<SovereigntyControlState, IconName> = {
  enforced: "shield",
  structural: "lock",
  development: "alert-triangle",
};

const CONTROL_LABELS: Record<SovereigntyControlState, string> = {
  enforced: "Enforced",
  structural: "Structural",
  development: "Development",
};

const CONTROL_BADGES: Record<SovereigntyControlState, string> = {
  enforced: "badge--success",
  structural: "badge--accent",
  development: "badge--warning",
};

export interface SovereigntyViewProps {
  /**
   * Workspace the audit record for a probe is filed against. The probe itself
   * covers the whole deployment; this is what makes the proof findable in the
   * audit log rather than recorded where nobody looks.
   */
  workspaceId: string | null;
}

export function SovereigntyView({ workspaceId }: SovereigntyViewProps): React.JSX.Element {
  const posture = useRemoteResource(
    useCallback(() => window.workbench.sovereignty.posture(), []),
    "sovereignty:posture",
  );
  const ledger = useRemoteResource<EgressLedger>(
    useCallback(() => window.workbench.sovereignty.egress({ limit: LEDGER_LIMIT }), []),
    "sovereignty:egress",
  );

  function refresh(): void {
    posture.reload();
    ledger.reload();
  }

  return (
    <section className="view" aria-label="Sovereignty">
      <header className="view__head">
        <div className="view__titles">
          <h1 className="view__title">Sovereignty</h1>
          <p className="view__subtitle">
            Where inference runs, what has left the premises, and how that is enforced.
          </p>
        </div>
        <div className="view__actions">
          {posture.data && (
            <span
              className={`badge ${posture.data.sovereign ? "badge--success" : "badge--warning"}`}
            >
              {posture.data.mode} profile
            </span>
          )}
          <IconButton
            icon="refresh"
            label="Refresh"
            onClick={refresh}
            tooltipAlign="end"
            disabled={posture.isLoading}
          />
        </div>
      </header>

      <div className="view__body">
        <div className="view__inner">
          {posture.error && !isAuthorisationFailure(posture.error) && (
            <p className="form-error" role="alert">
              <Icon name="alert-circle" size={14} />
              {posture.error}
            </p>
          )}

          {posture.isLoading && !posture.data && (
            <div className="center-state">
              <span className="spinner" aria-hidden="true" />
              Reading the enforcement posture…
            </div>
          )}

          {posture.data && (
            <>
              <Verdict posture={posture.data} ledger={ledger.data} />
              <LedgerSummary ledger={ledger} />
              <ControlsSection controls={posture.data.controls} />
              <CoverageSection posture={posture.data} />
              <ProvidersSection providers={posture.data.providers} />
              <ProbeSection sovereign={posture.data.sovereign} workspaceId={workspaceId} />
              <LedgerSection ledger={ledger} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

/**
 * The headline.
 *
 * Deliberately careful about the third case. A deployment running the sovereign
 * profile can still hold ledger rows from an earlier development run, and
 * reporting that as "nothing ever left" would be a lie of exactly the kind this
 * screen exists to prevent — so it is called out separately.
 */
function Verdict({
  posture,
  ledger,
}: {
  posture: SovereigntyPosture;
  ledger: EgressLedger | null;
}): React.JSX.Element {
  const remoteCalls = ledger?.summary.remoteCalls ?? null;

  if (!posture.sovereign) {
    return (
      <div className="verdict verdict--development">
        <span className="verdict__icon">
          <Icon name="alert-triangle" size={22} />
        </span>
        <span className="verdict__text">
          <span className="verdict__headline">Development profile — egress is possible</span>
          <span className="verdict__detail">
            Remote inference is {posture.allowRemoteInference ? "enabled" : "disabled"} and the
            container has a route off the host. Confidential and internal work is still refused a
            remote route, but this is not the sovereign posture. Deploy with{" "}
            <code>docker-compose.sovereign.yml</code> to seal it.
          </span>
        </span>
      </div>
    );
  }

  if (remoteCalls !== null && remoteCalls > 0) {
    return (
      <div className="verdict verdict--development">
        <span className="verdict__icon">
          <Icon name="clock" size={22} />
        </span>
        <span className="verdict__text">
          <span className="verdict__headline">Sealed now — {remoteCalls} historical off-premise calls</span>
          <span className="verdict__detail">
            Every egress control is in force, so nothing can leave from this point on. The ledger
            still holds {remoteCalls} call{remoteCalls === 1 ? "" : "s"} recorded before the
            deployment was sealed; they are listed below.
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="verdict verdict--sealed">
      <span className="verdict__icon">
        <Icon name="shield" size={22} />
      </span>
      <span className="verdict__text">
        <span className="verdict__headline">No inference has left the premises</span>
        <span className="verdict__detail">
          The container has no route off the host, remote profiles are unselectable, and every
          recorded model call resolved to a local runtime. Run the egress probe below to confirm the
          network posture live.
        </span>
      </span>
    </div>
  );
}

// ─── Summary tiles ───────────────────────────────────────────────────────────

function LedgerSummary({
  ledger,
}: {
  ledger: ReturnType<typeof useRemoteResource<EgressLedger>>;
}): React.JSX.Element | null {
  if (isAuthorisationFailure(ledger.error)) return null;
  if (!ledger.data) return null;

  const { summary } = ledger.data;

  return (
    <div className="stat-grid">
      <div className="stat">
        <span className="stat__label">
          <Icon name="cpu" size={12} />
          On-premise calls
        </span>
        <span className="stat__value">{summary.localCalls.toLocaleString()}</span>
        <span className="stat__note">Served by a local runtime</span>
      </div>

      <div className="stat">
        <span className="stat__label">
          <Icon name="globe" size={12} />
          Off-premise calls
        </span>
        <span
          className={`stat__value ${summary.remoteCalls === 0 ? "stat__value--good" : "stat__value--warn"}`}
        >
          {summary.remoteCalls.toLocaleString()}
        </span>
        <span className="stat__note">
          {summary.remoteHosts.length > 0 ? summary.remoteHosts.join(", ") : "No external destinations"}
        </span>
      </div>

      <div className="stat">
        <span className="stat__label">
          <Icon name="ban" size={12} />
          Refused by policy
        </span>
        <span className="stat__value">{summary.blockedAttempts.toLocaleString()}</span>
        <span className="stat__note">Attempts stopped before any request</span>
      </div>

      {summary.unknownCalls > 0 && (
        <div className="stat">
          <span className="stat__label">
            <Icon name="alert-circle" size={12} />
            Unclassified
          </span>
          <span className="stat__value stat__value--warn">
            {summary.unknownCalls.toLocaleString()}
          </span>
          <span className="stat__note">Provider no longer declared</span>
        </div>
      )}
    </div>
  );
}

// ─── Controls ────────────────────────────────────────────────────────────────

function ControlsSection({ controls }: { controls: SovereigntyControl[] }): React.JSX.Element {
  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Enforcement layers</h2>
        <p className="view__section-note">
          Independent controls. Each one alone prevents egress; the evidence column says where to
          confirm it.
        </p>
      </div>

      <div className="card">
        {controls.map((control) => (
          <div key={control.id} className="control">
            <span className={`control__icon control__icon--${control.state}`}>
              <Icon name={CONTROL_ICONS[control.state]} size={14} />
            </span>
            <span className="control__text">
              <span className="control__title">
                {control.title}
                <span className={`badge ${CONTROL_BADGES[control.state]}`}>
                  {CONTROL_LABELS[control.state]}
                </span>
              </span>
              <span className="control__detail">{control.detail}</span>
              <span className="control__evidence">
                <Icon name="code" size={11} />
                {control.evidence}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Capability coverage ─────────────────────────────────────────────────────

function CoverageSection({ posture }: { posture: SovereigntyPosture }): React.JSX.Element {
  const gaps = posture.capabilityCoverage.filter((entry) => !entry.sovereignReady);

  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">On-premise capability coverage</h2>
        <p className="view__section-note">
          {gaps.length === 0
            ? "Every required capability has a local profile, so the sovereign profile is fully self-sufficient."
            : `${gaps.length} capability ${gaps.length === 1 ? "has" : "have"} no local profile and would be unavailable once sealed.`}
        </p>
      </div>

      <div className="coverage">
        {posture.capabilityCoverage.map((entry) => (
          <div
            key={entry.capability}
            className={`coverage__item ${entry.sovereignReady ? "coverage__item--ready" : "coverage__item--gap"}`}
          >
            <Icon
              name={entry.sovereignReady ? "check-circle" : "alert-triangle"}
              size={14}
              className={entry.sovereignReady ? "" : ""}
            />
            <span className="coverage__name">{entry.capability}</span>
            <span className="coverage__counts">
              {entry.localProfiles} local · {entry.remoteProfiles} remote
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Declared destinations ───────────────────────────────────────────────────

function ProvidersSection({
  providers,
}: {
  providers: SovereigntyProvider[];
}): React.JSX.Element {
  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Declared inference destinations</h2>
        <p className="view__section-note">
          Every provider in the registry, whether or not policy currently permits it. Off-premise
          providers are dimmed — they exist for the development profile only.
        </p>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Destination</th>
                <th>Credential</th>
                <th>Policy</th>
                <th className="data-table__numeric">Profiles</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => {
                const remote = provider.location === "remote";
                const selectable = provider.profiles.filter((profile) => profile.selectable).length;

                return (
                  <tr key={provider.providerId} className={remote ? "is-dev" : ""}>
                    <td>
                      <span className="data-table__strong">{provider.providerId}</span>{" "}
                      <span className={`badge ${remote ? "badge--dev" : "badge--local"}`}>
                        {remote ? "dev · off-premise" : "on-premise"}
                      </span>
                    </td>
                    <td className="data-table__mono">{provider.host ?? "not configured"}</td>
                    <td>
                      {provider.requiresApiKey
                        ? provider.apiKeyPresent
                          ? "Key present"
                          : "Key absent"
                        : "None required"}
                    </td>
                    <td>
                      {provider.reachablePolicy ? (
                        "Selectable"
                      ) : (
                        <span className="badge badge--success">Blocked</span>
                      )}
                    </td>
                    <td className="data-table__numeric">
                      {selectable} / {provider.profiles.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── Live probe ──────────────────────────────────────────────────────────────

/**
 * The live demonstration.
 *
 * Attempts a real connection to every declared off-premise destination and
 * reports whether it was refused. This is what turns the sovereignty claim
 * from a description into something a reviewer watches fail in front of them —
 * which is also why it is a button rather than something the view does on
 * load: in the development profile these attempts genuinely reach the internet.
 */
function ProbeSection({
  sovereign,
  workspaceId,
}: {
  sovereign: boolean;
  workspaceId: string | null;
}): React.JSX.Element {
  const [result, setResult] = useState<EgressProbeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(): void {
    setRunning(true);
    setError(null);
    window.workbench.sovereignty
      .probe(workspaceId ?? undefined)
      .then(setResult)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunning(false));
  }

  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Live egress probe</h2>
        <p className="view__section-note">
          Attempts a connection to each declared off-premise host. In the sovereign profile every
          attempt fails at the transport layer, because the container has no route.
        </p>
      </div>

      <div className="card">
        <div className="card__head">
          <span className="card__title">
            {result
              ? result.allBlocked
                ? "Every destination refused the connection"
                : "At least one destination was reachable"
              : "Not run yet"}
          </span>
          <button type="button" className="btn btn--secondary" onClick={run} disabled={running}>
            {running ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Probing…
              </>
            ) : (
              <>
                <Icon name="activity" size={14} />
                Run egress probe
              </>
            )}
          </button>
        </div>

        <div className="card__body">
          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert-circle" size={14} />
              {error}
            </p>
          )}

          {!result && !error && (
            <p className="form-notice">
              <Icon name="alert-circle" size={13} />
              {sovereign
                ? "Run the probe to confirm the network posture live. Nothing can leave — the attempt is the proof."
                : "This deployment has a route off the host, so the probe will reach these destinations. That is expected in the development profile."}
            </p>
          )}

          {result && (
            <div className="probe">
              {result.targets.length === 0 && (
                <p className="form-notice">
                  <Icon name="alert-circle" size={13} />
                  No off-premise destinations are declared, so there is nothing to probe.
                </p>
              )}
              {result.targets.map((target) => (
                <div key={target.host} className={`probe__target probe__target--${target.verdict}`}>
                  <Icon
                    name={target.verdict === "blocked" ? "check-circle" : "alert-triangle"}
                    size={15}
                  />
                  <span className="probe__host">{target.host}</span>
                  {target.reason && <span className="probe__reason">{target.reason}</span>}
                  <span
                    className={`badge ${target.verdict === "blocked" ? "badge--success" : "badge--warning"}`}
                  >
                    {target.verdict}
                  </span>
                  <span className="probe__reason">{target.latencyMs} ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

function LedgerSection({
  ledger,
}: {
  ledger: ReturnType<typeof useRemoteResource<EgressLedger>>;
}): React.JSX.Element {
  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Recorded inference calls</h2>
        <p className="view__section-note">
          Metadata only — no prompt or document content is recorded. Off-premise calls are dimmed
          and tagged.
        </p>
      </div>

      {isAuthorisationFailure(ledger.error) ? (
        <p className="form-notice">
          <Icon name="lock" size={13} />
          The full ledger spans every workspace, so it is limited to administrators. The posture and
          probe above are available to everyone.
        </p>
      ) : ledger.error ? (
        <p className="form-error" role="alert">
          <Icon name="alert-circle" size={14} />
          {ledger.error}
        </p>
      ) : (
        <div className="card">
          {ledger.data && ledger.data.entries.length === 0 ? (
            <p className="card__empty">
              No model or embedding calls have been recorded yet. Run a task in the workbench and it
              will appear here.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Destination</th>
                    <th>Model</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th className="data-table__numeric">Latency</th>
                    <th className="data-table__numeric">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data?.entries.map((entry) => (
                    <LedgerRow key={`${entry.kind}:${entry.id}`} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {ledger.isLoading && (
            <p className="pager">
              <span className="spinner spinner--sm" aria-hidden="true" />
              Loading the ledger…
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function LedgerRow({ entry }: { entry: EgressEntry }): React.JSX.Element {
  const offPremise = entry.channel === "remote";

  return (
    <tr className={offPremise ? "is-dev" : ""}>
      <td className="data-table__mono">{formatTime(entry.at)}</td>
      <td>
        <span className="data-table__mono">{entry.host ?? entry.providerId}</span>{" "}
        <span
          className={`badge ${
            offPremise ? "badge--dev" : entry.channel === "local" ? "badge--local" : "badge--warning"
          }`}
        >
          {offPremise ? "dev · off-premise" : entry.channel === "local" ? "on-premise" : "unknown"}
        </span>
      </td>
      <td className="data-table__mono">{entry.modelId}</td>
      <td>{entry.kind}</td>
      <td>{entry.status.toLowerCase()}</td>
      <td className="data-table__numeric">{entry.latencyMs === null ? "—" : `${entry.latencyMs} ms`}</td>
      <td className="data-table__numeric">
        {entry.totalTokens === null ? "—" : entry.totalTokens.toLocaleString()}
      </td>
    </tr>
  );
}

/** Local time to the second — these rows are correlated against a live demo. */
function formatTime(iso: string): string {
  const at = new Date(iso);
  return `${at.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${at.toLocaleTimeString(undefined, { hour12: false })}`;
}
