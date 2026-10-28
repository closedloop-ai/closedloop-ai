// @ts-check
/**
 * ISS-7240 — the desktop design-system boundary gate.
 *
 * Wraps the `depcruise src --config scripts/dependency-cruiser.config.cjs` that
 * `assert:design-system-boundary` used to run bare. Same binary, same argument,
 * same config — the ONLY addition is the assertion the CLI cannot make: that
 * the cruise inspected something. See assert-design-system-boundary-lib.mjs for
 * why that distinction is the whole ticket.
 *
 * WHY A SUBPROCESS AND NOT THE `cruise()` API. Reimplementing the CLI in-process
 * is how this gate would go blind a second time. dependency-cruiser's CLI does
 * work the library entrypoint does not — `normalizeCliOptions`, and separate
 * `extractResolveOptions` / `extractTSConfigOptions` passes handed to `cruise()`
 * as its 3rd and 4th arguments. Two consequences were measured while building
 * this: omitting `validate: true` makes `cruise()` build the graph and evaluate
 * NO rules, reporting a confident `0 violations` on a tree that has six; and
 * even with it, the in-process resolve options produce a different graph than
 * the CLI (2258 modules / 7033 dependencies against the CLI's 2259 / 7040). A
 * gate whose engine is a near-copy of the real one is exactly the false green
 * ISS-7100 documented, so the real one is what runs.
 *
 * `--output-type json` is the one flag added, because the module count has to be
 * readable to be assertable. It changes the reporter, not the extraction or the
 * validation. It DOES move the exit code — the json reporter always exits 0 —
 * so the violation verdict is taken from `summary.error` here instead.
 *
 * Run from apps/desktop. `scripts/assert-supported-node.mjs` runs first in the
 * package script and refuses a Node version depcruise would reject.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAvailableTranspilers } from "dependency-cruiser";
import {
  checkModuleFloor,
  checkTypeScriptVisible,
  formatViolations,
  MODULE_FLOOR,
  tallyViolations,
} from "./assert-design-system-boundary-lib.mjs";

const CRUISE_TARGET = "src";
const CONFIG_PATH = "scripts/dependency-cruiser.config.cjs";

/**
 * Overrides so a test can drive THIS entrypoint — the only place the checks are
 * wired to an exit code — against a fixture instead of the real tree. Without
 * them, deleting the floor check or an `process.exit(1)` would leave the whole
 * suite green while the gate reported failure and exited 0, which is the exact
 * defect class this file exists to close.
 *
 * They are safe because the production invocation is asserted to pass NO
 * arguments (`design-system-boundary-gate.test.ts`), so `--floor` cannot be
 * used to quietly weaken the real gate without failing that test.
 */
function parseOverrides(argv) {
  const read = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const floor = read("--floor");
  return {
    target: read("--target") ?? CRUISE_TARGET,
    config: read("--config") ?? CONFIG_PATH,
    cwd: read("--cwd"),
    floor: floor === undefined ? MODULE_FLOOR : Number(floor),
  };
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");

/**
 * Absolute path to depcruise's own CLI entry, read from the installed package's
 * `bin` map rather than looked up on PATH or guessed relative to its module
 * entrypoint. Under `pnpm run` node_modules/.bin is on PATH and under a bare
 * `node scripts/assert-design-system-boundary.mjs` it is not, and the package's
 * internal layout is not ours to hardcode — a gate that cannot find its engine
 * must say so, not behave differently depending on how it was started.
 *
 * @returns {string}
 */
function resolveDepcruiseBin() {
  const require = createRequire(import.meta.url);
  let directory = path.dirname(
    fileURLToPath(import.meta.resolve("dependency-cruiser"))
  );
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = require(manifestPath);
      if (manifest.name === "dependency-cruiser") {
        return path.join(directory, manifest.bin.depcruise);
      }
    }
    directory = path.dirname(directory);
  }
  throw new Error(
    "could not locate the dependency-cruiser package from its own module entrypoint"
  );
}

/**
 * @param {string} reason
 * @returns {never}
 */
function refuse(reason) {
  process.stderr.write(
    `\n✖ design-system boundary gate REFUSED\n\n${reason}\n\n`
  );
  process.exit(1);
}

/**
 * Run the real depcruise CLI and hand back its JSON report.
 *
 * @returns {Promise<{stdout: string, stderr: string, code: number | null}>}
 */
function runDepcruise(overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolveDepcruiseBin(),
        overrides.target,
        "--config",
        overrides.config,
        "--output-type",
        "json",
      ],
      { cwd: overrides.cwd ?? desktopRoot, shell: false }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function main() {
  const overrides = parseOverrides(process.argv.slice(2));
  const visible = checkTypeScriptVisible(getAvailableTranspilers());
  if (!visible.ok) {
    refuse(/** @type {string} */ (visible.reason));
  }

  const { stdout, stderr, code } = await runDepcruise(overrides);
  if (!stdout.trim()) {
    refuse(
      `depcruise produced no report (exit ${code}).\n${stderr || "(no stderr)"}`
    );
  }

  /** @type {{summary: {totalCruised: number, totalDependenciesCruised: number, error: number, violations: {rule: {name: string}, from: string, to: string, via?: {name: string}[]}[]}}} */
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    refuse(
      `depcruise's JSON report did not parse (exit ${code}): ${error}\n${stderr}`
    );
  }

  const { summary } = report;
  const floor = checkModuleFloor(summary.totalCruised, overrides.floor);
  if (!floor.ok) {
    refuse(/** @type {string} */ (floor.reason));
  }

  const inspected = `${summary.totalCruised} modules, ${summary.totalDependenciesCruised} dependencies cruised`;
  const { blocking, nonBlocking } = tallyViolations(summary.violations);
  // Everything found is PRINTED; only `error` severity is blocking. Reporting
  // off the blocking count alone would let a warn-severity rule fire while this
  // printed "no dependency violations found" — a partially-clean cruise
  // reported as a fully-clean one.
  if (blocking + nonBlocking > 0) {
    process.stderr.write(`\n${formatViolations(summary.violations)}\n`);
  }
  if (blocking > 0) {
    process.stderr.write(
      `\nx ${blocking} blocking dependency violations (${inspected}).\n\n`
    );
    process.exit(1);
  }
  if (nonBlocking > 0) {
    process.stdout.write(
      `\n! ${nonBlocking} non-blocking dependency violations, 0 blocking (${inspected})\n`
    );
    return;
  }

  process.stdout.write(`✔ no dependency violations found (${inspected})\n`);
}

main().catch((error) => {
  refuse(
    `the boundary cruise threw before it could report:\n${error?.stack ?? error}`
  );
});
