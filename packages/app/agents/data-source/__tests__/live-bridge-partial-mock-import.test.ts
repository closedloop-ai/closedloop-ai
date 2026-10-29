import { describe, expect, it, vi } from "vitest";

/**
 * ISS-9553 — importing a live bridge must not read its domain key object.
 *
 * Several desktop renderer suites `vi.mock` the hooks module to stub the query
 * hooks without restating the key object. That was safe for as long as the
 * bridges touched `agentSessionKeys` only from inside `flush`. Deriving the
 * converge set at MODULE scope broke it: importing the bridge evaluated the
 * derivation, hit the partial mock, and threw
 * `No "agentSessionKeys" export is defined` at import time — a suite-level
 * failure that took down five whole files which never render this bridge.
 *
 * The prefixes are therefore resolved per call. This pins that, because nothing
 * else would: every other test in this package imports the real hooks module, so
 * the regression is invisible unless a partial mock is exercised on purpose.
 */

vi.mock("../../hooks/use-agent-sessions", () => ({
  // Deliberately partial: no `agentSessionKeys`, exactly as the desktop suites
  // that triggered this leave it.
  useAgentSessions: vi.fn(),
}));

vi.mock("../../../branches/hooks/use-branches", () => ({
  useBranchesPageData: vi.fn(),
}));

/**
 * Each case pays a cold dynamic import of a bridge and its transitive tree,
 * measured at ~5s on a loaded machine. That is transform cost, not a hang — the
 * default 5s budget makes these cases fail on scheduling luck rather than on
 * the contract they assert, so the bound is explicit.
 */
const IMPORT_TIMEOUT_MS = 30_000;

describe("live bridge module import under a partial hooks mock", () => {
  it(
    "imports the sessions bridge without reading agentSessionKeys",
    async () => {
      const bridge = await import("../agent-sessions-live-bridge");

      expect(typeof bridge.AgentSessionsLiveBridge).toBe("function");
    },
    IMPORT_TIMEOUT_MS
  );

  it(
    "imports the branches bridge without reading branchesKeys",
    async () => {
      const bridge = await import(
        "../../../branches/data-source/branches-live-bridge"
      );

      expect(typeof bridge.BranchesLiveBridge).toBe("function");
    },
    IMPORT_TIMEOUT_MS
  );

  it(
    "defers the derivation to call time, where the mock's gap is visible",
    async () => {
      // The positive counterpart: the derivation genuinely still depends on the
      // key object, so the module is lazy rather than accidentally independent of
      // it. The keys now live in `agent-session-keys`, which no suite mocks, so
      // the gap has to be staged here rather than inherited from the file-level
      // hooks mock — if this stopped throwing, the prefixes would have been
      // captured at import after all, or silently derived from nothing.
      vi.resetModules();
      vi.doMock("../../hooks/agent-session-keys", () => ({}));
      const { agentSessionAlwaysConvergePrefixes } = await import(
        "../../hooks/agent-session-cache-convergence"
      );

      expect(() => agentSessionAlwaysConvergePrefixes()).toThrow();
      vi.doUnmock("../../hooks/agent-session-keys");
      vi.resetModules();
    },
    IMPORT_TIMEOUT_MS
  );
});
