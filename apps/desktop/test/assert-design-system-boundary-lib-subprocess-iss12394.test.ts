import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHILD_CASE_TIMEOUT_MS,
  runModuleInChild,
} from "./support/module-child";

// The desktop c8 lane credits only code a child process runs, and for this lib
// its c8 record outranks the in-process one. So these cases call the real lib
// from a separate Node process and assert the verdicts it returns.

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const libUrl = pathToFileURL(
  path.join(desktopDir, "scripts/assert-design-system-boundary-lib.mjs")
).href;

function runInChild(body: string): unknown {
  return runModuleInChild({
    body: `const lib = m;\nout(await (async () => { ${body} })());`,
    cwd: desktopDir,
    moduleUrl: libUrl,
  });
}

describe("assert-design-system-boundary-lib in a child process", () => {
  it(
    "refuses when depcruise lists no typescript slot, and when the slot is unavailable",
    () => {
      const verdicts = runInChild(`
        const none = lib.checkTypeScriptVisible([{ name: "swc", available: true, version: "1", currentVersion: "1" }]);
        const missing = lib.checkTypeScriptVisible([{ name: "typescript", available: false, version: ">=2", currentVersion: "6.0.0" }]);
        const unresolved = lib.checkTypeScriptVisible([{ name: "typescript", available: false, version: ">=2" }]);
        const ok = lib.checkTypeScriptVisible([{ name: "typescript", available: true, version: ">=2", currentVersion: "6.0.0" }]);
        return { none, missing, unresolved, ok };
      `) as {
        none: { ok: boolean; reason: string };
        missing: { ok: boolean; reason: string };
        unresolved: { ok: boolean; reason: string };
        ok: { ok: boolean };
      };
      expect(verdicts.unresolved.reason).toContain("resolved: nothing.");
      expect(verdicts.none.ok).toBe(false);
      expect(verdicts.none.reason).toContain(
        'reports no "typescript" transpiler slot at all'
      );
      expect(verdicts.missing.ok).toBe(false);
      expect(verdicts.missing.reason).toContain(
        'accepts typescript@">=2" and resolved: 6.0.0.'
      );
      expect(verdicts.ok).toEqual({ ok: true });
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "reads each violation's severity and tallies warn as non-blocking",
    () => {
      const out = runInChild(`
        const violations = [
          { from: "a.ts", to: "b.ts", rule: { name: "r1", severity: "warn" }, via: [{ name: "m.ts" }] },
          { from: "c.ts", to: "d.ts", rule: { name: "r2" } },
        ];
        return { text: lib.formatViolations(violations), tally: lib.tallyViolations(violations) };
      `) as { text: string; tally: { blocking: number; nonBlocking: number } };
      expect(out.text).toBe(
        "  warn r1: a.ts → b.ts\n      m.ts →\n  error r2: c.ts → d.ts"
      );
      expect(out.tally).toEqual({ blocking: 1, nonBlocking: 1 });
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "names a zero-module cruise differently from a partial one",
    () => {
      const out = runInChild(`
        return {
          zero: lib.checkModuleFloor(0, 10),
          partial: lib.checkModuleFloor(3, 10),
          enough: lib.checkModuleFloor(10, 10),
          atDefault: lib.checkModuleFloor(lib.MODULE_FLOOR),
          belowDefault: lib.checkModuleFloor(lib.MODULE_FLOOR - 1),
        };
      `) as {
        zero: { ok: boolean; reason: string };
        partial: { ok: boolean; reason: string };
        enough: { ok: boolean };
        atDefault: { ok: boolean };
        belowDefault: { ok: boolean; reason: string };
      };
      expect(out.zero.ok).toBe(false);
      expect(out.zero.reason).toContain(
        "ZERO modules means the gate inspected nothing"
      );
      expect(out.partial.ok).toBe(false);
      expect(out.partial.reason).toContain(
        "gathered 3 modules, below the floor of 10."
      );
      expect(out.partial.reason).toContain(
        "graph is being gathered only partially"
      );
      expect(out.enough).toEqual({ ok: true });
      expect(out.atDefault).toEqual({ ok: true });
      expect(out.belowDefault.ok).toBe(false);
      expect(out.belowDefault.reason).toContain(
        "gathered 999 modules, below the floor of 1000."
      );
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
