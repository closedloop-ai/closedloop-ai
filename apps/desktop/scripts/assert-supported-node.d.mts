/**
 * Type declarations for `assert-supported-node.mjs` (ISS-7074 — the desktop
 * preflight Node guard). The guard is plain ESM JavaScript, so this sidecar is
 * what lets the typechecked `test/` project consume it without `allowJs`. Keep
 * the signatures in step with the `@ts-check` JSDoc on the implementation.
 */

/**
 * `undecidable` is the fail-open verdict, and is NOT a synonym for
 * `unsupported`: the guard prefixes `depcruise` in a `&&` chain, so treating an
 * input it could not evaluate as a refusal would take the boundary gate out of
 * the run.
 */
export type NodeSupportVerdict = "supported" | "unsupported" | "undecidable";

/**
 * Whether `nodeVersion` satisfies a dependency-cruiser-style range such as
 * `^22||^24||>=26`. A range containing a term this cannot parse is
 * `undecidable` rather than `unsupported`, because the unparsed term might have
 * been the one that matched.
 *
 * A PRERELEASE `nodeVersion` is `unsupported` against a range of bare `^`/`>=`
 * terms whatever its major, because that is what `semver.satisfies` — the call
 * depcruise actually makes — does with one. A range term carrying its own
 * prerelease falls outside the parsed grammar and is `undecidable`.
 */
export function evaluateNodeSupport(
  nodeVersion: string,
  range: string
): NodeSupportVerdict;

/**
 * Locate the installed dependency-cruiser manifest by walking `node_modules`
 * upward from `fromDirectory`, or `null` when it is not installed.
 * `require.resolve` cannot be used: the package's `exports` map publishes
 * neither a main nor `./package.json`.
 */
export function findDependencyCruiserManifest(
  fromDirectory: string
): string | null;

/** The operator-facing refusal, naming the `.nvmrc` pin as the remedy. */
export function formatUnsupportedNodeMessage(input: {
  nodeVersion: string;
  range: string;
  pinnedVersion: string | null;
}): string;

/**
 * Decide whether preflight can run, reading the range from the INSTALLED
 * dependency-cruiser manifest. `message` is non-null only for `unsupported`.
 */
export function checkPreflightNode(input: {
  nodeVersion: string;
  scriptDirectory: string;
  repoRoot: string;
}): { verdict: NodeSupportVerdict; message: string | null };

/** The repo root relative to `<root>/apps/desktop/scripts` — where `.nvmrc` lives. */
export function resolveRepoRootFrom(fromScriptDirectory: string): string;

/**
 * Whether this module was invoked as the CLI, compared by REALPATH (ISS-5730
 * semantics; `isCliInvocation` in scripts/deploy/summarize-playwright-results.ts
 * is the canonical owner). A plain `argv[1]` compare is symlink-fragile, and a
 * false compare makes an enforcement entrypoint exit 0 having enforced nothing.
 */
export function isCliInvocation(importMetaUrl: string): boolean;
