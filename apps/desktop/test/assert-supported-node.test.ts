/**
 * @file assert-supported-node.test.ts
 * @description ISS-7074: `pnpm --filter desktop test` could not complete on a
 * machine running an odd-numbered Node line, because `test:preflight`'s
 * `assert:design-system-boundary` step shells out to `depcruise` and
 * dependency-cruiser refuses any Node outside its own `engines.node`. Two
 * separate lanes lost time to it, and because it is the FIRST failing step of
 * preflight, `test:node` and `test:renderer` never ran — a lane could believe
 * it had tested the desktop app when the whole suite was skipped.
 *
 * Four things are pinned here:
 *
 *   1. The guard's verdict function, including its fail-open contract. The
 *      guard exists to improve a message, so it must never be able to refuse an
 *      environment depcruise would have accepted — and, because the boundary
 *      script is `node …assert-supported-node.mjs && node …assert-design-system-boundary.mjs`,
 *      it must not THROW either: a non-zero guard takes the cruise out of the run.
 *   2. The wiring — that the guard runs BEFORE the cruise and that the cruise is
 *      STILL invoked. The cheap "fix" for this ticket was to drop the boundary
 *      check, which trades a gate that fails loudly for one that is silently
 *      absent; this test fails if anyone does that. ISS-7240 moved the cruise
 *      itself behind `assert-design-system-boundary.mjs` (which additionally
 *      refuses a cruise that inspected nothing); depcruise is still what runs,
 *      one process further down.
 *   3. The shipped entrypoint, driven as a real subprocess. Naming the pinned
 *      version is the whole capability this guard buys over dependency-cruiser's
 *      own refusal, and it depends on argv/realpath wiring and a repo-root
 *      derivation that the exported functions do not expose.
 *   4. That `.nvmrc` pins a Node dependency-cruiser will actually run on.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPreflightNode,
  evaluateNodeSupport,
  findDependencyCruiserManifest,
  resolveRepoRootFrom,
} from "../scripts/assert-supported-node.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(testDirectory, "..");
const desktopScriptsDirectory = path.join(desktopDirectory, "scripts");
const repoRoot = path.resolve(desktopDirectory, "..", "..");

// The exact range dependency-cruiser 18 ships, and the exact Node this ticket
// was filed from. Kept literal so the regression case stays legible.
const DEPCRUISE_RANGE_AT_FILING = "^22||^24||>=26";
const UNSUPPORTED_NODE_AT_FILING = "25.9.0";
const BOUNDARY_SCRIPT_NAME = "assert:design-system-boundary";
const GUARD_COMMAND = "node scripts/assert-supported-node.mjs";
// ISS-7240 moved the cruise behind a wrapper that asserts the graph was
// actually inspected; the bare `depcruise src --config …` this used to name is
// now spawned by that wrapper rather than by the package script. The assertion
// below is unchanged in intent — the Node guard must still run FIRST, and the
// cruise must still run — only the command that carries the cruise moved.
const CRUISE_COMMAND = "node scripts/assert-design-system-boundary.mjs";

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function boundaryScriptCommands(): string[] {
  const manifest = readJson(path.join(desktopDirectory, "package.json"));
  const scripts = manifest.scripts as Record<string, string>;
  return scripts[BOUNDARY_SCRIPT_NAME].split("&&").map((part) => part.trim());
}

function installedDepcruiseRange(): string {
  const manifestPath = findDependencyCruiserManifest(desktopScriptsDirectory);
  if (!manifestPath) {
    throw new Error(
      "dependency-cruiser is not installed, so the range these tests reconcile against cannot be read"
    );
  }
  const manifest = readJson(manifestPath);
  const engines = manifest.engines as { node: string };
  return engines.node;
}

const scratchRoots: string[] = [];

afterEach(() => {
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop() as string, { recursive: true, force: true });
  }
});

/**
 * A monorepo-shaped throwaway tree: `<root>/.nvmrc` plus
 * `<root>/apps/desktop/{scripts,node_modules/dependency-cruiser}`. The guard
 * derives both of those locations from its own directory, so a fixture that
 * reproduces the shape is the only way to drive those paths without touching
 * the real `node_modules` (which no test may mutate, and which cannot be
 * re-installed on this machine).
 */
function scratchTree(manifestBody: string | null, pinned: string) {
  const root = mkdtempSync(path.join(tmpdir(), "iss7074-"));
  scratchRoots.push(root);
  const scripts = path.join(root, "apps", "desktop", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(root, ".nvmrc"), `${pinned}\n`);
  if (manifestBody !== null) {
    const depcruiseDir = path.join(
      root,
      "apps",
      "desktop",
      "node_modules",
      "dependency-cruiser"
    );
    mkdirSync(depcruiseDir, { recursive: true });
    writeFileSync(path.join(depcruiseDir, "package.json"), manifestBody);
  }
  return { root, scripts };
}

describe("ISS-7074: evaluateNodeSupport decides only what it can prove", () => {
  it("rejects the Node line that blocked two lanes", () => {
    expect(
      evaluateNodeSupport(UNSUPPORTED_NODE_AT_FILING, DEPCRUISE_RANGE_AT_FILING)
    ).toBe("unsupported");
  });

  it.each(["24.18.1", "v24.18.1", "22.14.0", "26.0.0", "27.1.0"])(
    "accepts %s",
    (version) => {
      expect(evaluateNodeSupport(version, DEPCRUISE_RANGE_AT_FILING)).toBe(
        "supported"
      );
    }
  );

  it("rejects a version below every term's floor", () => {
    expect(evaluateNodeSupport("20.19.0", DEPCRUISE_RANGE_AT_FILING)).toBe(
      "unsupported"
    );
  });

  it("treats a caret term as bounded above by the next major", () => {
    expect(evaluateNodeSupport("23.0.0", "^22")).toBe("unsupported");
    expect(evaluateNodeSupport("22.99.99", "^22")).toBe("supported");
  });

  it("honours the patch floor of a fully-specified term", () => {
    expect(evaluateNodeSupport("24.17.0", "^24.18.0")).toBe("unsupported");
    expect(evaluateNodeSupport("24.18.1", "^24.18.0")).toBe("supported");
  });

  // The fail-open contract. The guard is a message, not a policy: anything it
  // cannot evaluate must reach depcruise unchanged.
  it("is undecidable when an unmatched range contains a term it cannot parse", () => {
    expect(evaluateNodeSupport("25.9.0", "^22||~24||>=26")).toBe("undecidable");
  });

  it("still decides when a parseable term matches despite an unparseable sibling", () => {
    expect(evaluateNodeSupport("24.18.1", "~22||^24")).toBe("supported");
  });

  it.each(["", "   ", "not-a-range"])(
    "is undecidable for the unusable range %j",
    (range) => {
      expect(evaluateNodeSupport("25.9.0", range)).toBe("undecidable");
    }
  );

  it("is undecidable for an unparseable node version", () => {
    expect(evaluateNodeSupport("nightly", DEPCRUISE_RANGE_AT_FILING)).toBe(
      "undecidable"
    );
  });

  // A prerelease is the case where the tuple and depcruise disagree. depcruise
  // asks `semver.satisfies` with no `includePrerelease`, which admits a
  // prerelease only against a comparator carrying a prerelease on the same
  // major.minor.patch — so EVERY prerelease fails a range of bare `^`/`>=`
  // terms, including one whose base version sits squarely inside a term.
  // Reading the tuple alone reported these `supported`, which left the guard
  // silent and handed the author back the bare remedy-free depcruise error
  // this file exists to replace.
  it.each([
    ["24.18.1-rc.0", DEPCRUISE_RANGE_AT_FILING],
    ["26.0.0-rc.1", DEPCRUISE_RANGE_AT_FILING],
    ["v24.18.1-rc.0", DEPCRUISE_RANGE_AT_FILING],
    ["25.0.0-nightly20260101abcdef", DEPCRUISE_RANGE_AT_FILING],
    ["22.14.0-rc.0", "^22"],
    ["24.18.1-rc.0", "^24"],
    ["27.0.0-rc.0", ">=26"],
  ])("refuses the prerelease %s against %s", (version, range) => {
    expect(evaluateNodeSupport(version, range)).toBe("unsupported");
  });

  // The other half of semver's prerelease rule: a comparator that DOES carry a
  // prerelease can admit one, and which way it falls depends on the exact
  // tuple. That grammar is outside RANGE_TERM_PATTERN, so it must fail open
  // rather than be decided on a guess.
  it.each(["^24.18.1-rc.0", ">=24.0.0-rc.0", "^22||>=26.0.0-rc.1"])(
    "is undecidable for a prerelease against the term %s",
    (range) => {
      expect(evaluateNodeSupport("24.18.1-rc.0", range)).toBe("undecidable");
    }
  );

  // Build metadata is not a prerelease; semver ignores it when testing a range.
  it("still accepts a release carrying build metadata", () => {
    expect(
      evaluateNodeSupport("24.18.1+build.1", DEPCRUISE_RANGE_AT_FILING)
    ).toBe("supported");
  });

  // The version pattern is anchored at both ends, so trailing junk no longer
  // truncates to a version the guard would then assert something about.
  it("is undecidable for a version with unparseable trailing text", () => {
    expect(
      evaluateNodeSupport("24.18.1garbage", DEPCRUISE_RANGE_AT_FILING)
    ).toBe("undecidable");
  });
});

describe("ISS-7074: checkPreflightNode reads the real installed toolchain", () => {
  it("refuses the filing Node and names the pinned version as the remedy", () => {
    const pinned = readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim();
    const result = checkPreflightNode({
      nodeVersion: UNSUPPORTED_NODE_AT_FILING,
      scriptDirectory: desktopScriptsDirectory,
      repoRoot,
    });

    expect(result.verdict).toBe("unsupported");
    expect(result.message).toContain(UNSUPPORTED_NODE_AT_FILING);
    expect(result.message).toContain(pinned);
    expect(result.message).toContain(".nvmrc");
  });

  it("passes the version the repo pins, and emits no message", () => {
    const pinned = readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim();
    const result = checkPreflightNode({
      nodeVersion: pinned,
      scriptDirectory: desktopScriptsDirectory,
      repoRoot,
    });

    expect(result.verdict).toBe("supported");
    expect(result.message).toBeNull();
  });

  it("fails open when dependency-cruiser is not installed", () => {
    const result = checkPreflightNode({
      nodeVersion: UNSUPPORTED_NODE_AT_FILING,
      scriptDirectory: path.join(repoRoot, "does-not-exist"),
      repoRoot,
    });

    expect(result.verdict).toBe("undecidable");
    expect(result.message).toBeNull();
  });

  // A guard that THROWS exits non-zero, and `assert:design-system-boundary` is
  // `node scripts/assert-supported-node.mjs && depcruise …` — so an unhandled
  // throw here does not just misreport, it removes the boundary gate from the
  // run. Each unreadable manifest shape gets its own case for that reason.
  it.each([
    ["malformed JSON", "{ not json"],
    ["no engines block", '{"name":"dependency-cruiser"}'],
    ["no engines.node", '{"engines":{}}'],
    ["a blank engines.node", '{"engines":{"node":"   "}}'],
    ["a non-string engines.node", '{"engines":{"node":24}}'],
  ])("fails open on a manifest with %s", (_label, body) => {
    const { root, scripts } = scratchTree(body, "24.18.1");

    const result = checkPreflightNode({
      nodeVersion: UNSUPPORTED_NODE_AT_FILING,
      scriptDirectory: scripts,
      repoRoot: root,
    });

    expect(result.verdict).toBe("undecidable");
    expect(result.message).toBeNull();
  });

  it("reads the range from the manifest it finds, not from a copy of its own", () => {
    const { root, scripts } = scratchTree(
      '{"engines":{"node":"^99"}}',
      "99.0.1"
    );

    expect(
      checkPreflightNode({
        nodeVersion: "99.0.1",
        scriptDirectory: scripts,
        repoRoot: root,
      }).verdict
    ).toBe("supported");
    // The same Node the real dependency-cruiser accepts is refused here, which
    // it could not be if the range were hardcoded in the guard.
    expect(
      checkPreflightNode({
        nodeVersion: "24.18.1",
        scriptDirectory: scripts,
        repoRoot: root,
      }).verdict
    ).toBe("unsupported");
  });
});

describe("ISS-7074: the shipped entrypoint wiring", () => {
  it("derives the repo root that actually holds .nvmrc", () => {
    expect(resolveRepoRootFrom(desktopScriptsDirectory)).toBe(repoRoot);
    expect(() =>
      readFileSync(
        path.join(resolveRepoRootFrom(desktopScriptsDirectory), ".nvmrc"),
        "utf8"
      )
    ).not.toThrow();
  });

  // Driven as a real subprocess against a copy of the script, because the CLI
  // block reads `process.argv[1]`, `import.meta.url` and `process.versions.node`
  // — none of which the exported functions expose. `mkdtemp` sits under a
  // symlinked path on macOS (/var -> /private/var), so this ALSO pins the
  // realpath comparison in isCliInvocation: with a plain string compare the
  // guard silently no-ops and the unsupported case below exits 0.
  it("exits 1 and names the pinned version when the manifest refuses this Node", () => {
    const { root, scripts } = scratchTree(
      '{"engines":{"node":"^1"}}',
      "24.18.1"
    );
    const scriptCopy = path.join(scripts, "assert-supported-node.mjs");
    copyFileSync(
      path.join(desktopScriptsDirectory, "assert-supported-node.mjs"),
      scriptCopy
    );

    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [scriptCopy], { encoding: "utf8" });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toContain("24.18.1");
    expect(stderr).toContain(".nvmrc");
    expect(stderr).toContain(process.versions.node);
    expect(readFileSync(path.join(root, ".nvmrc"), "utf8").trim()).toBe(
      "24.18.1"
    );
  });

  it("exits 0 silently when the manifest accepts this Node", () => {
    const { scripts } = scratchTree('{"engines":{"node":">=0"}}', "24.18.1");
    const scriptCopy = path.join(scripts, "assert-supported-node.mjs");
    copyFileSync(
      path.join(desktopScriptsDirectory, "assert-supported-node.mjs"),
      scriptCopy
    );

    const stdout = execFileSync(process.execPath, [scriptCopy], {
      encoding: "utf8",
    });

    expect(stdout).toBe("");
  });
});

describe("ISS-7074: the boundary gate is diagnosed, never removed", () => {
  it("runs the node guard before the cruise, and still runs the cruise", () => {
    const commands = boundaryScriptCommands();
    const guardIndex = commands.findIndex((command) =>
      command.startsWith(GUARD_COMMAND)
    );
    const cruiseIndex = commands.indexOf(CRUISE_COMMAND);

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(cruiseIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(cruiseIndex);
  });

  it("keeps the boundary gate inside test:preflight", () => {
    const manifest = readJson(path.join(desktopDirectory, "package.json"));
    const scripts = manifest.scripts as Record<string, string>;

    expect(scripts["test:preflight"]).toContain(BOUNDARY_SCRIPT_NAME);
    expect(scripts.test).toContain("test:preflight");
  });
});

// `.nvmrc` is what CI installs (~28 workflows read it through
// `node-version-file`), so a pin dependency-cruiser refuses would break the
// desktop boundary gate for EVERYONE rather than only for a developer whose
// shell is off-pin. That is the version relationship worth holding.
//
// Deliberately NOT asserted here: that root `engines.node` excludes the Node
// majors dependency-cruiser refuses. It does not — `">=24"` admits 25 — and
// correcting it is a one-line change that pnpm turns into an `[WARN]
// Unsupported engine` line on the STDOUT of every pnpm invocation, which
// breaks callers that parse that stdout as JSON (`parseTurboDryRun` in
// scripts/lint/turbo-dry-run.ts finds the `{` inside the warning itself). CI never sees it, because CI is always on-pin. See ISS-7074's
// findings: that is a human's call, not this ticket's.
describe("ISS-7074: the pinned Node must be one the desktop toolchain accepts", () => {
  it("pins an .nvmrc version dependency-cruiser will run on", () => {
    const pinned = readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim();

    expect(evaluateNodeSupport(pinned, installedDepcruiseRange())).toBe(
      "supported"
    );
  });
});
