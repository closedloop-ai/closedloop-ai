import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Harness, HarnessValues } from "@repo/lib/harness/types";
import { harnessScanRoots } from "../src/main/collectors/engine/harness-scan-roots.js";

// FEA-3639: the file-access probe must cover every harness collector-manager
// boots — otherwise a TCC block on an uncovered harness (e.g. default-on Copilot)
// reproduces the exact silent stall the banner exists to prevent. This backs the
// compile-time exhaustiveness of the `Record<Harness, …>` registry with a runtime
// check, so a new harness that skips the map fails here too.
describe("harnessScanRoots", () => {
  test("covers every harness so none silently escapes the probe", () => {
    const covered = new Set(harnessScanRoots().map((entry) => entry.harness));
    for (const harness of HarnessValues) {
      assert.ok(
        covered.has(harness),
        `harness not covered by the file-access probe: ${harness}`
      );
    }
    assert.equal(covered.size, HarnessValues.length);
  });

  test("every harness resolves at least one scan root", () => {
    for (const { harness, roots } of harnessScanRoots()) {
      assert.ok(roots.length > 0, `harness has no scan roots: ${harness}`);
    }
  });

  test("skips harnesses the enabled predicate rejects", () => {
    // FEA-3639 review: the probe must honor the per-tool collector-enabled
    // snapshot so a disabled harness's root is never opened (CollectorManager
    // skips its tool-home walk; the probe must not incidentally touch it).
    const roots = harnessScanRoots((harness) => harness !== Harness.Copilot);
    const covered = new Set(roots.map((entry) => entry.harness));

    assert.ok(
      !covered.has(Harness.Copilot),
      "a disabled harness must be skipped by the probe"
    );
    assert.equal(covered.size, HarnessValues.length - 1);
  });
});
