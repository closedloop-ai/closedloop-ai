/**
 * @file design-system-boundary-gate.test.ts
 * @description ISS-7240 / ISS-7241 — the gate that guards the boot boundary,
 * guarded in turn.
 *
 * `assert:design-system-boundary` spent 2026-08-11 to 2026-08-19 passing while
 * inspecting nothing: dependency-cruiser probes
 * `tryImportAvailable("typescript", ">=2.0.0 <7.0.0")`, the workspace moved to
 * typescript@7, `.ts` left `scannableExtensions`, and `depcruise src` gathered
 * 0 modules and exited 0. Four call sites reported success and two boot-path
 * regressions landed through the window.
 *
 * The lesson is that "exit 0" was never the contract — "inspected the graph AND
 * found nothing wrong" is. These tests hold the three claims that make the
 * difference, each able to fail on its own:
 *
 *   1. the gate REFUSES when TypeScript is invisible (the exact 2026-08-11
 *      regression) and when the module count collapses (its symptom);
 *   2. dependency-cruiser can, right now, actually see TypeScript;
 *   3. the config's `reachable: true` rules genuinely FIRE — a transitive
 *      violation is reported, not merely configured. ISS-7100's 5-module
 *      reference run could not fire them (2 of its 3 edges were
 *      `couldNotResolve`, the graph stopped at depth 1), so a healthy-looking
 *      module count alone does not prove the rules are live.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAvailableTranspilers } from "dependency-cruiser";
import { test } from "vitest";
import {
  checkModuleFloor,
  checkTypeScriptVisible,
  formatViolations,
  MODULE_FLOOR,
  REQUIRED_TRANSPILER,
} from "../scripts/assert-design-system-boundary-lib.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
// A depcruise invocation NOT routed through the guarded script. The separator
// class includes `/` so a path-qualified form (`./node_modules/.bin/depcruise`)
// cannot slip past — matching only on whitespace would let the exact bypass
// this sweep exists to catch evade it. Whole-line comments are stripped before
// matching; the tool's name inside a LIVE command still matches, which is the
// safe direction to err in for a sweep like this.
const BARE_DEPCRUISE = /(?:^|[\s&|;`/])(?:npx\s+)?depcruise\s+\S/m;
const CONFIG_PATH = path.join(
  desktopRoot,
  "scripts",
  "dependency-cruiser.config.cjs"
);
const BOOT_RULE = "boot-no-design-system-runtime";

// Hoisted per the repo's `useTopLevelRegex` rule.
const NAMES_THE_REMEDY = /packageExtensions/;
const NAMES_THE_CONSEQUENCE = /inspect NOTHING/;
const NAMES_THE_MISSING_SLOT = /no "typescript" transpiler slot/;
const NAMES_ZERO_MODULES = /ZERO modules/;
const NAMES_INSPECTED_NOTHING = /inspected nothing/;
const NAMES_THE_FLOOR = /below the floor/;
const FORBIDS_LOWERING_THE_FLOOR = /Do NOT lower this floor/;
const RENDERS_THE_INTERMEDIATE_HOP = /src\/main\/agent-sync\/lane\.ts/;
const RENDERS_THE_RULE_NAME = new RegExp(BOOT_RULE);
const RUNS_THE_GUARDED_SCRIPT = /scripts\/assert-design-system-boundary\.mjs/;
const RUNS_A_BARE_DEPCRUISE = /(^|\s)depcruise\s/;
const RUNS_THE_BOUNDARY_GATE = /assert:design-system-boundary/;
const RUNS_PREFLIGHT = /test:preflight/;
const CI_RUNS_PREFLIGHT = /--filter desktop run test:preflight/;
const BLOCKING_VIOLATIONS = /blocking dependency violations/;
const NO_VIOLATIONS_FOUND = /no dependency violations found/;
const PASSES_NO_ARGUMENTS = /assert-design-system-boundary\.mjs\s*$/;
// `test(?:\s|$)` and NOT `test\b`: `\b` is satisfied by the `t`→`:` boundary,
// so it also matched `run test:preflight`. Downgrading the post-merge job from
// the full desktop suite to the cheap preflight is the realistic narrowing this
// call site exists to catch, and it would have stayed green.
const CI_RUNS_THE_DESKTOP_SUITE = /--filter desktop run test(?:\s|$)/m;

const AVAILABLE_TYPESCRIPT = {
  name: REQUIRED_TRANSPILER,
  version: ">=2.0.0 <7.0.0",
  available: true,
  currentVersion: "typescript@6.0.3",
};

test("the gate refuses when dependency-cruiser cannot see TypeScript", () => {
  // The 2026-08-11 regression byte for byte: the slot exists, the range is
  // declared, and the resolved compiler is out of it.
  const verdict = checkTypeScriptVisible([
    { ...AVAILABLE_TYPESCRIPT, available: false, currentVersion: "-" },
  ]);

  assert.equal(verdict.ok, false);
  // The refusal has to name the remedy, or the next lane re-derives ISS-7100's
  // diagnosis from "0 modules" — which is what actually happened.
  assert.match(String(verdict.reason), NAMES_THE_REMEDY);
  assert.match(String(verdict.reason), NAMES_THE_CONSEQUENCE);
});

test("the gate refuses when the TypeScript slot is gone entirely", () => {
  const verdict = checkTypeScriptVisible([
    {
      name: "javascript",
      version: "*",
      available: true,
      currentVersion: "a@1",
    },
  ]);

  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), NAMES_THE_MISSING_SLOT);
});

test("the gate accepts an in-range TypeScript", () => {
  assert.deepEqual(checkTypeScriptVisible([AVAILABLE_TYPESCRIPT]), {
    ok: true,
  });
});

test("the gate refuses a cruise that inspected NOTHING", () => {
  // The whole ticket in one assertion: 0 modules must be a failure, not the
  // silent success it was for eight days.
  const verdict = checkModuleFloor(0);

  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), NAMES_ZERO_MODULES);
  assert.match(String(verdict.reason), NAMES_INSPECTED_NOTHING);
});

test("the gate refuses a partially-gathered graph, and forbids lowering the floor", () => {
  const verdict = checkModuleFloor(MODULE_FLOOR - 1);

  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), NAMES_THE_FLOOR);
  assert.match(String(verdict.reason), FORBIDS_LOWERING_THE_FLOOR);
});

test("the gate accepts a four-figure module count", () => {
  assert.deepEqual(checkModuleFloor(MODULE_FLOOR), { ok: true });
  assert.deepEqual(checkModuleFloor(2259), { ok: true });
});

test("a reported violation names the hops, not just the endpoints", () => {
  // These rules are `reachable: true`, so the offending import lives on an
  // intermediate hop. Printing only from→to sends the reader to a file whose
  // imports are all innocent.
  const rendered = formatViolations([
    {
      rule: { name: BOOT_RULE },
      from: "src/main/app.ts",
      to: "src/main/database/store.ts",
      via: [
        { name: "src/main/agent-sync/lane.ts" },
        { name: "src/main/database/store.ts" },
      ],
    },
  ]);

  assert.match(rendered, RENDERS_THE_INTERMEDIATE_HOP);
  assert.match(rendered, RENDERS_THE_RULE_NAME);
});

test("dependency-cruiser can see TypeScript in this install", () => {
  // The live half of the first refusal above, and the direct detector for the
  // repair: drop the pnpm-workspace.yaml packageExtensions entry that gives
  // dependency-cruiser its own in-range typescript and this goes red.
  //
  // Runs the REAL tool output through the REAL decision function rather than
  // re-deriving the check here, so the thing under test is the gate's actual
  // verdict and not a second implementation of it that could disagree.
  const verdict = checkTypeScriptVisible(getAvailableTranspilers());

  assert.equal(verdict.ok, true, verdict.reason);
});

test("the config's reachable rules fire on a TRANSITIVE boot-path violation", () => {
  // A positive control, because the production tree is (now) clean and a green
  // cruise cannot distinguish "no violations" from "rules never evaluated".
  // Measured while building this: calling the `cruise()` API without
  // `validate: true` reports a confident 0 violations on a tree that has six.
  //
  // The entry imports something innocent; the forbidden module is two hops
  // down. Only the transitive `reachable: true` analysis can catch that.
  const fixture = mkdtempSync(path.join(tmpdir(), "ds-boundary-gate-"));
  try {
    const write = (relativePath: string, contents: string): void => {
      const absolute = path.join(fixture, relativePath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    };
    write(
      "tsconfig.json",
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"esnext"}}\n'
    );
    write(
      "src/main/app.ts",
      'import { l } from "./agent-sync/lane.js";\nexport const a = l;\n'
    );
    write(
      "src/main/agent-sync/lane.ts",
      'import { s } from "../database/store.js";\nexport const l = s;\n'
    );
    write("src/main/database/store.ts", "export const s = 1;\n");

    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          depcruiseBin(),
          "src",
          "--config",
          CONFIG_PATH,
          "--output-type",
          "json",
        ],
        { cwd: fixture, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
      )
    );

    const violation = report.summary.violations.find(
      (candidate: { rule: { name: string } }) =>
        candidate.rule.name === BOOT_RULE
    );
    assert.ok(
      violation,
      `${BOOT_RULE} did not fire on a graph built to violate it; the reachable rules are not live. Cruised ${report.summary.totalCruised} modules, violations: ${JSON.stringify(report.summary.violations)}`
    );
    assert.equal(violation.from, "src/main/app.ts");
    assert.equal(violation.to, "src/main/database/store.ts");
    // The hop the entry did NOT import directly. Its presence is what proves
    // the analysis is transitive rather than a direct-edge match.
    assert.ok(
      violation.via.some(
        (hop: { name: string }) => hop.name === "src/main/agent-sync/lane.ts"
      ),
      `expected a transitive hop through the sync lane; via was ${JSON.stringify(violation.via)}`
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the gate ENTRYPOINT exits non-zero when the cruise inspected too little", () => {
  // The decision functions above are pure, so they cannot catch the mutation
  // that matters most: deleting the floor check, or the `process.exit(1)`, in
  // main(). Either one leaves every other assertion in this file green while
  // the gate prints its findings and reports success — which is precisely the
  // 8-day failure this ticket exists to end. So drive the shipped entrypoint
  // and assert the EXIT CODE, the way test/assert-supported-node.test.ts drives
  // its own script.
  const fixture = writeBoundaryFixture();
  try {
    const result = runGateEntrypoint(fixture, []);

    assert.notEqual(
      result.status,
      0,
      `the gate must refuse a 3-module cruise; it exited ${result.status}\n${result.stderr}`
    );
    assert.match(result.stderr, NAMES_THE_FLOOR);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the gate ENTRYPOINT exits non-zero on a real boundary violation", () => {
  // The other half: with the floor satisfied, a violating graph must still fail.
  // `--floor 1` is safe to use here because the production invocation is
  // asserted below to pass NO arguments, so this seam cannot be used to weaken
  // the real gate without reddening that test.
  const fixture = writeBoundaryFixture();
  try {
    const result = runGateEntrypoint(fixture, ["--floor", "1"]);

    assert.notEqual(
      result.status,
      0,
      `the gate must refuse a boot-path violation; it exited ${result.status}\n${result.stdout}`
    );
    assert.match(result.stderr, RENDERS_THE_RULE_NAME);
    assert.match(result.stderr, BLOCKING_VIOLATIONS);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the gate ENTRYPOINT exits zero on a clean graph", () => {
  // Without this the two refusals above could both be satisfied by a gate that
  // refuses everything, which would be green and useless.
  const fixture = writeBoundaryFixture({ violating: false });
  try {
    const result = runGateEntrypoint(fixture, ["--floor", "1"]);

    assert.equal(
      result.status,
      0,
      `a clean graph must pass; got ${result.status}\n${result.stderr}`
    );
    assert.match(result.stdout, NO_VIOLATIONS_FOUND);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the package script runs the guarded gate, not a bare depcruise", () => {
  // Wiring: without this, deleting the guard from the script leaves every
  // assertion above green while the gate goes back to being unable to report
  // that it inspected nothing.
  const require = createRequire(import.meta.url);
  const manifest = require("../package.json");
  const script: string = manifest.scripts["assert:design-system-boundary"];

  assert.match(script, RUNS_THE_GUARDED_SCRIPT);
  assert.doesNotMatch(
    script,
    RUNS_A_BARE_DEPCRUISE,
    "the gate must go through assert-design-system-boundary.mjs, which asserts the module floor; a bare depcruise cannot report that it inspected nothing"
  );
  // The entrypoint accepts --target/--config/--floor so the tests above can
  // drive it against a fixture. This is what stops that seam being turned on
  // the real gate: production passes NOTHING, so nobody can quietly cruise a
  // narrower target or drop the floor without reddening this line.
  assert.match(
    script,
    PASSES_NO_ARGUMENTS,
    "the production gate must run with no arguments, so its target, config, and module floor are always the defaults"
  );
});

test("every call site reaches the gate through the guarded package script", () => {
  // ISS-7241. The repair only helps where it is actually reached. Four surfaces
  // run this check, and while the gate was blind ALL FOUR reported success —
  // the boundary had no live enforcement anywhere, pre- or post-merge. They are
  // enumerated here so the set is maintained rather than rediscovered, and each
  // is asserted to route through `assert:design-system-boundary` rather than
  // reimplement the cruise.
  const require = createRequire(import.meta.url);
  const manifest = require("../package.json");

  // 1 + 2 + 3: the package scripts, and the two chains CI enters through.
  assert.match(manifest.scripts["test:preflight"], RUNS_THE_BOUNDARY_GATE);
  assert.match(manifest.scripts.test, RUNS_PREFLIGHT);

  // 4: the pre-commit hook.
  const lintStaged = readFileSync(
    path.join(repoRoot, "lint-staged.config.js"),
    "utf8"
  );
  assert.match(lintStaged, RUNS_THE_BOUNDARY_GATE);

  // The CI entrypoints. `pr-test.yml` runs preflight pre-merge;
  // `desktop-test-validation.yml` runs the full desktop suite post-merge on
  // main, and its preflight is the merge-queue backstop.
  //
  // Comments are stripped before matching. Both workflows DESCRIBE these chains
  // in prose several times over, so a match against the raw text would stay
  // green if the actual step were deleted — the same "looks like coverage,
  // enforces nothing" shape this pair of tickets exists to remove.
  assert.match(workflowCommands("pr-test.yml"), CI_RUNS_PREFLIGHT);
  assert.match(
    workflowCommands("desktop-test-validation.yml"),
    CI_RUNS_THE_DESKTOP_SUITE
  );
});

test("no workflow or hook bypasses the gate with a bare depcruise", () => {
  // The failure this prevents is a FIFTH call site: someone adds
  // `depcruise src` to a workflow, it goes green, and it enforces nothing the
  // day the next tooling upgrade lands — which is precisely the shape ISS-7240
  // had to unpick. Every invocation must go through the guarded script.
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const surfaces = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(workflowDir, name));
  surfaces.push(path.join(repoRoot, "lint-staged.config.js"));

  const offenders = surfaces.filter((surface) =>
    BARE_DEPCRUISE.test(stripComments(readFileSync(surface, "utf8")))
  );

  assert.deepEqual(
    offenders.map((surface) => path.relative(repoRoot, surface)),
    [],
    "these surfaces invoke depcruise directly, so they cruise without the module-floor guard and can pass while inspecting nothing"
  );
});

/**
 * A minimal desktop-shaped tree the real config can be cruised against.
 * `violating: true` puts the forbidden `src/main/database/` module two hops
 * behind an innocent-looking boot entry, so only the transitive analysis finds
 * it; `false` drops that last hop and leaves a clean graph.
 */
function writeBoundaryFixture({ violating = true } = {}): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "ds-boundary-gate-"));
  const write = (relativePath: string, contents: string): void => {
    const absolute = path.join(fixture, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  write(
    "tsconfig.json",
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"esnext"}}\n'
  );
  write(
    "src/main/app.ts",
    'import { l } from "./agent-sync/lane.js";\nexport const a = l;\n'
  );
  if (violating) {
    write(
      "src/main/agent-sync/lane.ts",
      'import { s } from "../database/store.js";\nexport const l = s;\n'
    );
    write("src/main/database/store.ts", "export const s = 1;\n");
  } else {
    write("src/main/agent-sync/lane.ts", "export const l = 1;\n");
  }
  return fixture;
}

/** Run the shipped gate entrypoint against a fixture and capture its exit. */
function runGateEntrypoint(
  fixture: string,
  extraArgs: readonly string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      path.join(desktopRoot, "scripts", "assert-design-system-boundary.mjs"),
      "--cwd",
      fixture,
      "--config",
      CONFIG_PATH,
      ...extraArgs,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Drop whole-line comments so an assertion sees only what CI would execute.
 * These workflows narrate their own chains in prose, and a guard that a comment
 * can satisfy is not a guard.
 *
 * Both comment syntaxes, because the swept set is not all YAML —
 * `lint-staged.config.js` is JavaScript, where a `//` line would otherwise read
 * as a live command.
 */
function stripComments(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith("#") || trimmed.startsWith("//"));
    })
    .join("\n");
}

function workflowCommands(fileName: string): string {
  return stripComments(
    readFileSync(path.join(repoRoot, ".github", "workflows", fileName), "utf8")
  );
}

function depcruiseBin(): string {
  const require = createRequire(import.meta.url);
  let directory = path.dirname(
    fileURLToPath(import.meta.resolve("dependency-cruiser"))
  );
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = require(path.join(directory, "package.json"));
      if (manifest.name === "dependency-cruiser") {
        return path.join(directory, manifest.bin.depcruise);
      }
    } catch {
      // Keep walking: not every ancestor directory has a package.json.
    }
    directory = path.dirname(directory);
  }
  throw new Error("could not locate the dependency-cruiser package");
}
