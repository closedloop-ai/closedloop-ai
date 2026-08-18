import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-4667: the desktop-local LOC/$ projection. Split out of
 * `shared-agent-sessions-api.test.ts` so the cost-efficiency contract — which
 * numerator the ratio divides cost into, and how it reconciles with the "Lines
 * changed" row rendered beside it — reads as one unit instead of being buried
 * in the mapper's omnibus detail assertions.
 *
 * Every fixture here bills $0.25 (`billingMode: "api"`), so the expected ratio
 * is always `numerator / 0.25`.
 */

describe("shared agent sessions LOC/$ projection", () => {
  test("with no branch diff, the numerator is the local working-tree diff", async () => {
    const localSession = {
      ...session({ id: "session-local-only", status: "completed" }),
      linesAdded: 120,
      linesRemoved: 12,
    } satisfies SyncedAgentSession;
    const source = createFakeSource({
      cursorRows: [cursor("session-local-only")],
      sessions: { "session-local-only": localSession },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-local-only"
    );

    // Numerator = 120 + 12 = 132 lines. locPerDollar = 132 / $0.25 = 528, and
    // kloc = 132 / 1000 = 0.132 — the SAME basis, in the two different units.
    assert.equal(detail?.linesAdded, 120);
    assert.equal(detail?.linesRemoved, 12);
    assert.equal(detail?.locPerDollar, 528);
    assert.equal(detail?.kloc, 0.132);
  });

  // ISS-4667 (wongk): the local LOC/$ projection must divide cost into the SAME
  // numerator the shared "Lines changed" row shows — `max(localDiff, branchDiff)`
  // — not the bare local working-tree residual. A merged multi-PR session whose
  // local diff has collapsed to 56 lines but whose branch diff is 4,004 must read
  // its efficiency over 4,004, or the ratio contradicts the lines it claims to be
  // over.
  test("reconciles with the larger branch diff, not the local residual", async () => {
    const mergedSession = {
      ...session({
        id: "session-merged-multi-pr",
        status: "completed",
      }),
      // Local working-tree residual after the branches merged/reset: tiny.
      linesAdded: 50,
      linesRemoved: 6,
      // The real delivered code lives in the branch diff (4,004 lines changed).
      branchDiffStats: {
        linesAdded: 3315,
        linesRemoved: 689,
        filesChanged: 88,
        source: "branch_fallback",
      },
    } satisfies SyncedAgentSession;
    const source = createFakeSource({
      cursorRows: [cursor("session-merged-multi-pr")],
      sessions: { "session-merged-multi-pr": mergedSession },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-merged-multi-pr"
    );

    // Cost is $0.25 (api billing). Numerator = max(56 local, 4004 branch) = 4004.
    // locPerDollar = 4004 / 0.25 = 16016; kloc = 4004 / 1000 = 4.004. Both derive
    // from the SAME 4,004-line basis the "Lines changed" row prints — they cannot
    // disagree, and the ratio is NOT the ~224 the 56-line residual would produce.
    assert.equal(detail?.locPerDollar, 16_016);
    assert.equal(detail?.kloc, 4.004);
  });
});
