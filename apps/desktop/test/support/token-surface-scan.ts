/**
 * The PostHog token/client needles the Electron surfaces must not contain, and
 * the walk that looks for them.
 *
 * Extracted (ISS-6367) because the scan runs from more than one place on
 * different inputs: `no-token-surface.test.ts` over the desktop SOURCE surfaces
 * in the desktop test lanes, `no-token-surface-dist.test.ts` over the BUILT
 * bundle in `desktop-build`, and — since ISS-9219 — `scripts/deploy/
 * no-token-surface-github.test.ts` over `.github` in `deploy-guards`. One copy
 * of the needle list, so a needle added for one input cannot be missing from
 * the others.
 *
 * Each needle is assembled from parts so this module does not itself match the
 * scan.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const FORBIDDEN_TOKEN_NEEDLES = [
  ["CL", "POSTHOG"].join("_"),
  ["posthog", "node"].join("-"),
  ["posthog", "config"].join("-"),
  ["PostHog", "Analytics"].join(""),
  ["phc", "_"].join(""),
];

/**
 * The SOURCE roots scanned from the desktop test lanes, which are gated on the
 * `desktop` path filter.
 *
 * ISS-9219 moved `.github` OUT of this list. That root is watched by four named
 * workflow files in the `desktop` filter while the scan read the whole tree, so
 * a `phc_` in any other `.github` file reached `main` unguarded and then
 * reddened the next unrelated PR that happened to touch a desktop path — and
 * whether the guard ran at all depended on merge-group composition rather than
 * on what the change touched. It is now {@link GITHUB_SCAN_ROOTS}, run from
 * `scripts/deploy/no-token-surface-github.test.ts` in a lane whose filter covers
 * the whole directory. Every root here is under `apps/desktop/**`, which the
 * `desktop` filter carries wholesale.
 *
 * `scripts/deploy/no-token-surface-github.test.ts` asserts that containment for
 * both lists, so a root added to either one fails CI rather than re-opening the
 * hole silently.
 */
export const DESKTOP_SOURCE_SCAN_ROOTS = [
  "apps/desktop/electron-builder.yml",
  "apps/desktop/package.json",
  "apps/desktop/src",
] as const;

/** The repo-wide root, gated on `deploy_scripts`. See above. */
export const GITHUB_SCAN_ROOTS = [".github"] as const;

const BINARY_PATH_PATTERN = /\.(icns|png|zip|dmg)$/i;

/**
 * Directory names never descended into. Applied to CHILD entries only, so a
 * caller may still point the walk AT one of them — which is how the built-output
 * scan reaches `apps/desktop/dist` while the source scan stays out of it.
 */
const SKIPPED_DIRECTORY_ENTRIES = new Set(["dist", "dist-dmg", "node_modules"]);

/**
 * Append `"<relativePath>: <needle>"` for every forbidden needle found under
 * `absolutePath`, recursing into directories.
 */
export function collectTokenSurfaceMatches(
  absolutePath: string,
  relativePath: string,
  matches: string[]
): void {
  if (statSync(absolutePath).isDirectory()) {
    for (const entry of readdirSync(absolutePath)) {
      if (SKIPPED_DIRECTORY_ENTRIES.has(entry)) {
        continue;
      }
      collectTokenSurfaceMatches(
        path.join(absolutePath, entry),
        path.join(relativePath, entry),
        matches
      );
    }
    return;
  }

  if (BINARY_PATH_PATTERN.test(relativePath)) {
    return;
  }

  const contents = readFileSync(absolutePath, "utf8");
  for (const needle of FORBIDDEN_TOKEN_NEEDLES) {
    if (contents.includes(needle)) {
      matches.push(`${relativePath}: ${needle}`);
    }
  }
}
