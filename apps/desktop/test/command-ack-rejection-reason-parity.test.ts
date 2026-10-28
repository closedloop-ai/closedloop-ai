import {
  classifyDesktopCommandAckRejection,
  DesktopCommandAckRejectionReason,
  knownDesktopCommandAckWireReasons,
  legacyDesktopCommandAckWireReasons,
} from "@repo/api/src/types/desktop-command-ack";
import { describe, expect, it } from "vitest";
import {
  GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS,
  GITHUB_RESYNC_NUDGE_INVALID_REASON,
} from "../src/main/github/github-resync-nudge.js";
import { COMMAND_ACK_REJECTION_REASONS } from "../src/shared/ack-reasons.js";

/**
 * ISS-7486: the server folds these wire strings to bounded metric codes, but
 * `packages/api` cannot import `apps/desktop`, so the fold table duplicates the
 * literals. This test is the seam that duplication needs: rename a reason on
 * the producer without updating the fold and the rejection silently reclassifies
 * to `unknown` in prod, hiding the reject path the ticket exists to name.
 *
 * `apps/desktop` can import both sides, so the check lives here.
 *
 * REVIEW (#5723, whitlockk): the first cut enumerated producers by hand and reached
 * eleven of the eighteen entries the fold table held then. The seven it missed
 * — the three `validateCommand` reasons, the three routed in `app.ts`, and the
 * revocation failure — were inline literals at their producers, so renaming any
 * one of them dropped the fold to `unknown` with this file still green. That is the exact
 * drift the file exists to catch, so the shape is now SET EQUALITY against the
 * fold table rather than a longer hand-list: a hand-list can only fail to grow.
 */

/**
 * Every wire reason this build can put on a rejected ack. Sourced from the
 * producers' own constants, never re-typed here — a literal in this file would
 * be a third copy and would pass while production drifted.
 */
const PRODUCER_REASONS: readonly string[] = [
  ...Object.values(COMMAND_ACK_REJECTION_REASONS),
  ...Object.values(GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS),
  GITHUB_RESYNC_NUDGE_INVALID_REASON,
];

describe("desktop command-ack rejection reasons fold to known codes", () => {
  it.each(PRODUCER_REASONS)(
    "%s folds to a known code",
    (wireReason: string) => {
      expect(classifyDesktopCommandAckRejection(wireReason)).not.toBe(
        DesktopCommandAckRejectionReason.Unknown
      );
    }
  );

  it("no producer reason is missing from the fold table", () => {
    // The direction that catches a rename at the PRODUCER: the constant moves,
    // the fold table does not, and the reject lands in `unknown` in prod.
    const folded = new Set(knownDesktopCommandAckWireReasons());
    expect(PRODUCER_REASONS.filter((reason) => !folded.has(reason))).toEqual(
      []
    );
  });

  it("no fold-table entry has lost its producer", () => {
    // The other direction, which a hand-list cannot check at all: a mapping kept
    // after its producer was renamed or deleted is dead, and it reads as coverage
    // for a reject path nothing can emit any more. The retired entries are
    // subtracted by NAME, so a mapping can only escape this check by being
    // declared legacy on purpose.
    const produced = new Set(PRODUCER_REASONS);
    const legacy = new Set(legacyDesktopCommandAckWireReasons());
    expect(
      knownDesktopCommandAckWireReasons().filter(
        (reason) => !(produced.has(reason) || legacy.has(reason))
      )
    ).toEqual([]);
  });

  it("every retired reason is still accepted, so an old build keeps its bucket", () => {
    // ISS-7486 split the two context reasons; a Desktop that predates the split
    // still sends the old string, and folding it to `unknown` would lose the
    // reject path that owned 100% of production rejections.
    const legacy = legacyDesktopCommandAckWireReasons();
    expect(legacy.length).toBeGreaterThan(0);
    for (const reason of legacy) {
      expect(classifyDesktopCommandAckRejection(reason)).not.toBe(
        DesktopCommandAckRejectionReason.Unknown
      );
    }
  });

  it("no retired reason is still emitted by a producer", () => {
    // The mirror of the check above: a string listed as retired while a producer
    // still sends it would report live traffic as version skew.
    const produced = new Set(PRODUCER_REASONS);
    expect(
      legacyDesktopCommandAckWireReasons().filter((reason) =>
        produced.has(reason)
      )
    ).toEqual([]);
  });

  it("proves the guard can fail — an unmapped producer string is caught", () => {
    expect(
      classifyDesktopCommandAckRejection("unauthorized: renamed by a refactor")
    ).toBe(DesktopCommandAckRejectionReason.Unknown);
  });
});
