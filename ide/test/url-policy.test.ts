import { afterEach, describe, expect, it } from "vitest";

import { evaluateUrl, isUrlAllowed } from "../src/main/services/url-policy.js";

const ALLOWLIST_VAR = "WORKBENCH_BROWSER_ALLOWLIST";

afterEach(() => {
  delete process.env[ALLOWLIST_VAR];
});

describe("evaluateUrl with no allowlist configured", () => {
  it("permits http and https", () => {
    expect(isUrlAllowed("https://example.com/page")).toBe(true);
    expect(isUrlAllowed("http://example.com")).toBe(true);
  });

  it("refuses schemes that could reach the local machine", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x", "about:blank"]) {
      const decision = evaluateUrl(url);
      expect(decision.allowed, url).toBe(false);
      expect(decision.reason).toBeTruthy();
    }
  });

  it("refuses unparseable input", () => {
    expect(evaluateUrl("not a url").allowed).toBe(false);
    expect(evaluateUrl("").allowed).toBe(false);
  });
});

describe("evaluateUrl with an allowlist configured", () => {
  it("permits listed hosts and their subdomains", () => {
    process.env[ALLOWLIST_VAR] = "docs.internal.gov.in, example.com";

    expect(isUrlAllowed("https://example.com/a")).toBe(true);
    expect(isUrlAllowed("https://www.example.com/a")).toBe(true);
    expect(isUrlAllowed("https://docs.internal.gov.in")).toBe(true);
  });

  it("refuses hosts that merely start with a listed host", () => {
    process.env[ALLOWLIST_VAR] = "example.com";

    // The case a naive `startsWith` check would wrongly admit.
    expect(isUrlAllowed("https://example.com.attacker.test")).toBe(false);
    expect(isUrlAllowed("https://notexample.com")).toBe(false);
  });

  it("refuses unlisted hosts and explains why", () => {
    process.env[ALLOWLIST_VAR] = "example.com";
    const decision = evaluateUrl("https://elsewhere.test");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("elsewhere.test");
  });

  it("matches hosts case-insensitively", () => {
    process.env[ALLOWLIST_VAR] = "Example.COM";

    expect(isUrlAllowed("https://EXAMPLE.com/a")).toBe(true);
  });

  it("ignores blank entries and surrounding whitespace", () => {
    process.env[ALLOWLIST_VAR] = " , example.com ,, ";

    expect(isUrlAllowed("https://example.com")).toBe(true);
    expect(isUrlAllowed("https://other.test")).toBe(false);
  });

  it("still enforces the scheme restriction", () => {
    process.env[ALLOWLIST_VAR] = "example.com";

    expect(isUrlAllowed("file://example.com/x")).toBe(false);
  });
});
