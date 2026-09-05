/**
 * Decides which URLs the embedded browser may load.
 *
 * Every check goes through `new URL()` rather than string prefix matching. A
 * `startsWith("https://example.gov.in")` test would happily admit
 * `https://example.gov.in.attacker.test`, which is exactly the mistake
 * Electron's security guide calls out.
 */

/** Only these schemes can ever reach the embedded browser. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Comma-separated hosts the pane may visit, from `WORKBENCH_BROWSER_ALLOWLIST`.
 *
 * Unset means "any host over http/https", which is the right default while the
 * agent's browsing tool is still being built and the operator has not yet
 * decided what it may reach. A sovereign deployment is expected to set this —
 * see `ide/README.md`. A host entry also covers its subdomains.
 */
function readAllowlist(): string[] {
  const raw = process.env["WORKBENCH_BROWSER_ALLOWLIST"] ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export interface UrlDecision {
  allowed: boolean;
  /** Human-readable rejection reason, suitable for showing in the UI. */
  reason?: string;
}

export function evaluateUrl(candidate: string): UrlDecision {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { allowed: false, reason: `Not a valid URL: ${candidate}` };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: `Blocked scheme "${url.protocol}" — only http and https are allowed.` };
  }

  const allowlist = readAllowlist();
  if (allowlist.length === 0) return { allowed: true };

  const host = url.hostname.toLowerCase();
  const permitted = allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));

  return permitted
    ? { allowed: true }
    : { allowed: false, reason: `Host "${host}" is not in WORKBENCH_BROWSER_ALLOWLIST.` };
}

export function isUrlAllowed(candidate: string): boolean {
  return evaluateUrl(candidate).allowed;
}
