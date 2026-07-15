/**
 * @file installed-version.test.ts
 * @description FEA-2923: unit tests for resolveInstalledPackVersion, the pure
 * logic behind the runtime's getInstalledPackVersion() callback that lets the
 * auto-install reconciler read real installed state (progressing past "pending"
 * to installed) instead of the former hardcoded-null stub.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveInstalledPackVersion } from "../src/main/packs/installed-version.js";
import type { InstalledPackDetail } from "../src/shared/agent-db-contract.js";

function makeDetail(
  installs: Array<{ version: string | null }>
): InstalledPackDetail {
  return {
    packId: "rtk",
    harnesses: ["claude"],
    installs: installs.map((i, idx) => ({
      harness: "claude",
      installPath: `/packs/rtk-${idx}`,
      installKind: "plugin",
      sourceUrl: null,
      version: i.version,
      detectedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    })),
    skillCount: 0,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    skills: [],
    associations: [],
  };
}

describe("resolveInstalledPackVersion", () => {
  test("returns null when the pack is not installed (detail is null)", () => {
    // null → reconciler treats the pack as 'needs install'.
    assert.equal(resolveInstalledPackVersion(null), null);
  });

  test("returns the concrete version of a single installed pack", () => {
    const detail = makeDetail([{ version: "1.2.3" }]);
    assert.equal(resolveInstalledPackVersion(detail), "1.2.3");
  });

  test("returns the first concrete version when installs differ", () => {
    const detail = makeDetail([{ version: null }, { version: "2.0.0" }]);
    assert.equal(resolveInstalledPackVersion(detail), "2.0.0");
  });

  test("returns the 'installed' sentinel when the pack is present but versionless", () => {
    // A pack that is installed but carries no version must still resolve to a
    // non-null value so the reconciler does NOT loop re-installing it.
    const detail = makeDetail([{ version: null }]);
    assert.equal(resolveInstalledPackVersion(detail), "installed");
  });

  test("returns 'installed' when installs array is empty but detail exists", () => {
    const detail = makeDetail([]);
    assert.equal(resolveInstalledPackVersion(detail), "installed");
  });
});
