import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { app } from "electron";

/**
 * Sign-in values prefilled during development.
 *
 * Convenience only, and deliberately fenced in two ways: nothing is returned
 * from a packaged build, and nothing is hardcoded — the values come from the
 * environment, or from the repository's own `.env`, which already holds the
 * seeded development credentials in plaintext on this machine.
 *
 * A released build therefore always opens on an empty form.
 */

export interface SignInDefaults {
  baseUrl: string;
  email: string;
  password: string;
}

const DEFAULT_BASE_URL = "http://localhost:4000";

/** How far to walk up looking for the repository's `.env`. */
const MAX_SEARCH_DEPTH = 4;

/**
 * Candidate `.env` locations, nearest first.
 *
 * Walks up from both the app path and the working directory rather than from
 * this module's location: `import.meta.dirname` is undefined once the file is
 * bundled to CommonJS, and the two starting points differ between `npm run
 * dev`, a packaged app, and the test harnesses.
 */
function envCandidates(): string[] {
  const candidates: string[] = [];

  for (const start of [app.getAppPath(), process.cwd()]) {
    let directory = resolve(start);
    for (let depth = 0; depth <= MAX_SEARCH_DEPTH; depth += 1) {
      candidates.push(join(directory, ".env"));

      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  return [...new Set(candidates)];
}

export function signInDefaults(): SignInDefaults | undefined {
  if (app.isPackaged) return undefined;

  const fileEnv = readRepositoryEnv();
  const email = process.env["WORKBENCH_EMAIL"] ?? fileEnv["SEED_ADMIN_EMAIL"];
  const password = process.env["WORKBENCH_PASSWORD"] ?? fileEnv["SEED_ADMIN_PASSWORD"];
  if (!email || !password) return undefined;

  return {
    baseUrl: process.env["WORKBENCH_BACKEND_URL"] ?? fileEnv["WORKBENCH_BACKEND_URL"] ?? DEFAULT_BASE_URL,
    email,
    password,
  };
}

/**
 * Minimal `.env` reader.
 *
 * Only needs to find two keys in a file this repository owns, so it handles
 * `KEY=value` with optional quotes and skips comments rather than pulling in a
 * dotenv dependency for a development-only convenience.
 */
function readRepositoryEnv(): Record<string, string> {
  let contents: string | undefined;
  for (const candidate of envCandidates()) {
    try {
      contents = readFileSync(candidate, "utf8");
      break;
    } catch {
      // Try the next location.
    }
  }
  if (contents === undefined) return {};

  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}
