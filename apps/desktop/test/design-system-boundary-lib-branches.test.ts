/**
 * ISS-11105 — the design-system boundary gate's decision helpers on the inputs
 * `design-system-boundary-gate.test.ts` never feeds them: a transpiler probe
 * with no resolved version, violations whose parsed JSON omits `severity` or
 * `via`, and a cruise that finds only non-blocking violations.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkTypeScriptVisible,
  formatViolations,
  REQUIRED_TRANSPILER,
  tallyViolations,
} from "../scripts/assert-design-system-boundary-lib.mjs";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const WARN_RULE = "fixture-warn-only";
const FIXTURE_CONFIG = "fixture.depcruise.cjs";
const GATE_CHILD_TIMEOUT_MS = 60_000;
const GATE_TEST_TIMEOUT_MS = 90_000;

const RESOLVED_NOTHING = /resolved: nothing\./;
const NON_BLOCKING_SUMMARY =
  /! 1 non-blocking dependency violations, 0 blocking \(\d+ modules/;
const RENDERS_WARN_VIOLATION = new RegExp(
  `  warn ${WARN_RULE}: src/main/app\\.ts → src/main/agent-sync/lane\\.ts`
);
const NO_VIOLATIONS_FOUND = /no dependency violations found/;
const BLOCKING_VIOLATIONS = /blocking dependency violations \(/;

describe("checkTypeScriptVisible", () => {
  it("reports 'nothing' resolved when the probe omits currentVersion", () => {
    const verdict = checkTypeScriptVisible([
      {
        name: REQUIRED_TRANSPILER,
        version: ">=2.0.0 <7.0.0",
        available: false,
      },
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(RESOLVED_NOTHING);
  });
});

describe("formatViolations", () => {
  it("labels a violation with no severity as error and renders no hop lines without via", () => {
    const rendered = formatViolations([
      { rule: { name: "some-rule" }, from: "src/a.ts", to: "src/b.ts" },
    ]);

    expect(rendered).toBe("  error some-rule: src/a.ts → src/b.ts");
  });

  it("renders one line per hop under the header", () => {
    const rendered = formatViolations([
      {
        rule: { name: "some-rule", severity: "warn" },
        from: "src/a.ts",
        to: "src/c.ts",
        via: [{ name: "src/b.ts" }],
      },
    ]);

    expect(rendered).toBe(
      "  warn some-rule: src/a.ts → src/c.ts\n      src/b.ts →"
    );
  });
});

describe("tallyViolations", () => {
  it("counts error and missing severity as blocking, any other severity as non-blocking", () => {
    const tally = tallyViolations([
      { rule: { name: "r1", severity: "error" }, from: "a", to: "b" },
      { rule: { name: "r2" }, from: "a", to: "b" },
      { rule: { name: "r3", severity: "warn" }, from: "a", to: "b" },
    ]);

    expect(tally).toEqual({ blocking: 2, nonBlocking: 1 });
  });
});

describe("the gate entrypoint with only warn-severity violations", () => {
  it("prints the violation and a non-blocking summary, and exits zero", {
    timeout: GATE_TEST_TIMEOUT_MS,
  }, () => {
    const fixture = writeWarnFixture();
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            desktopRoot,
            "scripts",
            "assert-design-system-boundary.mjs"
          ),
          "--cwd",
          fixture,
          "--config",
          FIXTURE_CONFIG,
          "--floor",
          "1",
        ],
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          // spawnSync blocks the worker, so only a deadline on the child can
          // end a wedged cruise.
          timeout: GATE_CHILD_TIMEOUT_MS,
          killSignal: "SIGKILL",
        }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toMatch(RENDERS_WARN_VIOLATION);
      expect(result.stderr).not.toMatch(BLOCKING_VIOLATIONS);
      expect(result.stdout).toMatch(NON_BLOCKING_SUMMARY);
      expect(result.stdout).not.toMatch(NO_VIOLATIONS_FOUND);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

/**
 * A two-module tree plus a config holding one direct-edge (non-`reachable`)
 * rule at `warn`, so the cruise reports a violation that carries no `via` and
 * must not block.
 */
function writeWarnFixture(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "ds-boundary-warn-"));
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
  write("src/main/agent-sync/lane.ts", "export const l = 1;\n");
  write(
    FIXTURE_CONFIG,
    `module.exports = {
  forbidden: [
    {
      name: ${JSON.stringify(WARN_RULE)},
      severity: "warn",
      from: { path: "^src/main/app\\\\.ts$" },
      to: { path: "^src/main/agent-sync/" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: false,
    doNotFollow: { path: "node_modules" },
  },
};
`
  );
  return fixture;
}
