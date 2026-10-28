// @ts-check
/**
 * ISS-7074 — say WHY the boundary gate cannot run, instead of letting
 * dependency-cruiser refuse the Node version with no remedy.
 *
 * `assert:design-system-boundary` shells out to `depcruise`, whose bin throws
 * from `assert-node-environment-suitable.mjs` when the running Node falls
 * outside dependency-cruiser's own `engines.node`. That range tracks the
 * Node.js release cycle and therefore skips the odd-numbered Current lines, so
 * a developer on Node 25 gets a bare "your node version is not supported" with
 * no mention of the version this repo actually pins. It lands in the two places
 * that hurt most:
 *
 *   - `pnpm --filter desktop test`, where the failure is the FIRST step of
 *     `test:preflight`, so `test:node` and `test:renderer` never run at all;
 *   - lint-staged's DESKTOP_AGENT_DASHBOARD_BOUNDARY_GUARD, which puts it
 *     inside the husky pre-commit hook for any `apps/desktop/src/**` change and
 *     pushes the author toward `--no-verify`.
 *
 * The repo already has the answer: `.nvmrc` pins the Node version and every
 * workflow consumes it through `node-version-file`. This guard only surfaces
 * that at the point of failure.
 *
 * IT ADDS NO POLICY OF ITS OWN. The range it enforces is read from the
 * installed dependency-cruiser manifest rather than copied here, and every
 * input it cannot evaluate — a missing manifest, a range term it does not
 * recognise, an unparseable version — resolves to `undecidable`, which exits 0
 * and lets `depcruise` speak for itself. It can refuse only what depcruise was
 * about to refuse anyway, 0.3s later and less usefully.
 *
 * The mirror of that rule is that a version depcruise PROVABLY refuses must
 * reach `unsupported`, or the guard is silent exactly where it was meant to
 * speak. A prerelease Node — `24.18.1-rc.0`, a `-nightly` build — is that case:
 * depcruise tests with `semver.satisfies` and no `includePrerelease`, which
 * admits a prerelease only against a comparator carrying a prerelease on the
 * same major.minor.patch, so a range of bare `^`/`>=` terms refuses every
 * prerelease whatever its major. See satisfiesTerm.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The two range operators dependency-cruiser has used for years (`^22||^24||>=26`).
// A term this does not match makes the whole evaluation undecidable — see
// evaluateNodeSupport, and the comment there for why "unmatched" cannot mean
// "unsatisfied". The grammar admits no prerelease, which is precisely what lets
// satisfiesTerm refuse one outright.
const RANGE_TERM_PATTERN = /^(\^|>=)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
// Anchored at BOTH ends, and the prerelease tag is captured rather than run off
// the end of the match: `24.18.1-rc.0` is not `24.18.1`, and semver disagrees
// with that truncation. Build metadata is matched but discarded, because semver
// ignores it when testing a range. Anything else trailing the patch number is
// not a version this can evaluate, so it parses as null and fails open.
const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {"supported" | "unsupported" | "undecidable"} NodeSupportVerdict
 */

/**
 * @typedef {object} ParsedVersion
 * @property {number[]} tuple [major, minor, patch].
 * @property {boolean} isPrerelease Whether a `-tag` suffix was present. Carried
 *   separately from the tuple because it changes the answer without changing
 *   the ordering the tuple encodes.
 */

/**
 * Compare two [major, minor, patch] tuples.
 *
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 * @returns {number}
 */
function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

/**
 * @param {string} value
 * @returns {ParsedVersion | null}
 */
function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    tuple: [Number(match[1]), Number(match[2]), Number(match[3])],
    isPrerelease: match[4] !== undefined,
  };
}

/**
 * @param {string} term
 * @param {ParsedVersion} version
 * @returns {boolean | null} null when the term's grammar is unrecognised.
 */
function satisfiesTerm(term, version) {
  const match = RANGE_TERM_PATTERN.exec(term.trim());
  if (!match) {
    return null;
  }
  // depcruise asks `semver.satisfies` without `includePrerelease`, and that
  // admits a prerelease ONLY against a comparator carrying a prerelease on the
  // same major.minor.patch — so `24.18.1-rc.0` fails `^24` even though the
  // tuple alone says otherwise. RANGE_TERM_PATTERN cannot express a
  // prerelease, so no term reaching this line is that comparator, and a term
  // that does carry one fails the pattern above and lands on `undecidable`
  // instead of being decided here on a guess.
  if (version.isPrerelease) {
    return false;
  }
  const base = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  if (compareVersions(version.tuple, base) < 0) {
    return false;
  }
  // `^N` is caret-on-a-nonzero-major, so it is bounded above by the next major.
  return match[1] === ">=" || version.tuple[0] === base[0];
}

/**
 * Decide whether `nodeVersion` satisfies a dependency-cruiser-style range.
 *
 * @param {string} nodeVersion e.g. "25.9.0" or "v25.9.0".
 * @param {string} range e.g. "^22||^24||>=26".
 * @returns {NodeSupportVerdict}
 */
export function evaluateNodeSupport(nodeVersion, range) {
  const version = parseVersion(nodeVersion);
  if (!version) {
    return "undecidable";
  }
  const terms = range.split("||").filter((term) => term.trim().length > 0);
  if (terms.length === 0) {
    return "undecidable";
  }
  let sawUnrecognisedTerm = false;
  for (const term of terms) {
    const satisfied = satisfiesTerm(term, version);
    if (satisfied === true) {
      return "supported";
    }
    if (satisfied === null) {
      sawUnrecognisedTerm = true;
    }
  }
  // A term we could not parse might have been the one that matched, so a
  // no-match run that contained one proves nothing. Fail open rather than
  // refuse an environment depcruise would have accepted.
  return sawUnrecognisedTerm ? "undecidable" : "unsupported";
}

/**
 * Locate the installed dependency-cruiser manifest by walking `node_modules`
 * the way Node's own resolver does. `require.resolve` cannot be used: the
 * package publishes an `exports` map with neither a main nor `./package.json`.
 *
 * @param {string} fromDirectory
 * @returns {string | null}
 */
export function findDependencyCruiserManifest(fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.join(
      directory,
      "node_modules",
      "dependency-cruiser",
      "package.json"
    );
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * @param {object} input
 * @param {string} input.nodeVersion
 * @param {string} input.range
 * @param {string | null} input.pinnedVersion Contents of .nvmrc, when readable.
 * @returns {string}
 */
export function formatUnsupportedNodeMessage({
  nodeVersion,
  range,
  pinnedVersion,
}) {
  const pinnedLine = pinnedVersion
    ? `This repo pins Node ${pinnedVersion} in .nvmrc, which every CI workflow consumes\nvia \`node-version-file\`, so CI is unaffected — only your shell is off-pin.`
    : "This repo pins its Node version in .nvmrc, which every CI workflow consumes\nvia `node-version-file`.";

  return `
apps/desktop preflight cannot run on Node ${nodeVersion}.

dependency-cruiser — the engine behind \`pnpm assert:design-system-boundary\` —
supports node ${range} and refuses everything else, because it tracks the
Node.js release cycle and skips the odd-numbered Current lines.

${pinnedLine}

Switch to the pinned version and re-run, e.g. one of:

    nvm use
    mise use node@${pinnedVersion ?? "<.nvmrc version>"}
    fnm use

then confirm with \`node --version\` before retrying.

Do NOT work around this by dropping assert:design-system-boundary from
test:preflight or by committing with --no-verify: that turns a gate that fails
loudly into one that is silently absent.
`;
}

/**
 * @param {object} input
 * @param {string} input.nodeVersion
 * @param {string} input.scriptDirectory
 * @param {string} input.repoRoot
 * @returns {{ verdict: NodeSupportVerdict, message: string | null }}
 */
export function checkPreflightNode({ nodeVersion, scriptDirectory, repoRoot }) {
  const manifestPath = findDependencyCruiserManifest(scriptDirectory);
  if (!manifestPath) {
    return { verdict: "undecidable", message: null };
  }

  let range;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    range = manifest?.engines?.node;
  } catch {
    return { verdict: "undecidable", message: null };
  }
  if (typeof range !== "string" || range.trim().length === 0) {
    return { verdict: "undecidable", message: null };
  }

  const verdict = evaluateNodeSupport(nodeVersion, range);
  if (verdict !== "unsupported") {
    return { verdict, message: null };
  }

  let pinnedVersion = null;
  try {
    const nvmrcPath = path.join(repoRoot, ".nvmrc");
    if (existsSync(nvmrcPath)) {
      pinnedVersion = readFileSync(nvmrcPath, "utf8").trim() || null;
    }
  } catch {
    pinnedVersion = null;
  }

  return {
    verdict,
    message: formatUnsupportedNodeMessage({
      nodeVersion,
      range,
      pinnedVersion,
    }),
  };
}

/**
 * The repo root, relative to this script's own directory
 * (`<root>/apps/desktop/scripts`). Exported because it is where `.nvmrc` is
 * read from, and naming the pinned version is the entire capability this guard
 * buys over dependency-cruiser's own refusal: get the derivation wrong and the
 * message silently degrades to the generic branch while still exiting 1.
 *
 * @param {string} fromScriptDirectory
 * @returns {string}
 */
export function resolveRepoRootFrom(fromScriptDirectory) {
  return path.resolve(fromScriptDirectory, "..", "..", "..");
}

/**
 * Whether this module was invoked as the CLI, compared by REALPATH.
 *
 * ISS-5730 established this for enforcement entrypoints; `isCliInvocation` in
 * scripts/deploy/summarize-playwright-results.ts is the canonical owner and
 * carries the full rationale. It cannot be imported here — that module is
 * TypeScript and this one is bare-node `.mjs` run by `package.json` — so the
 * semantics are mirrored rather than a third copy of the fragile idiom.
 *
 * The plain `process.argv[1] === fileURLToPath(import.meta.url)` comparison is
 * symlink-fragile: node reports `argv[1]` as the path the process was invoked
 * BY, while `import.meta.url` is the module's resolved realpath. On a checkout
 * reached through a symlink the two differ, the guard is false, and this script
 * exits 0 having enforced nothing — after which `&&` runs depcruise, which
 * refuses with the bare remedy-free error this whole file exists to replace.
 *
 * @param {string} importMetaUrl
 * @returns {boolean}
 */
export function isCliInvocation(importMetaUrl) {
  const entryPath = process.argv[1];
  const modulePath = fileURLToPath(importMetaUrl);
  if (!entryPath) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return entryPath === modulePath;
  }
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

if (isCliInvocation(import.meta.url)) {
  const { verdict, message } = checkPreflightNode({
    nodeVersion: process.versions.node,
    scriptDirectory,
    repoRoot: resolveRepoRootFrom(scriptDirectory),
  });
  if (verdict === "unsupported" && message) {
    process.stderr.write(message);
    process.exitCode = 1;
  }
}
