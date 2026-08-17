import { ReadSource } from "@repo/api/src/types/read-source";
import { describe, expect, it } from "vitest";
import { describeCloudReadCutover } from "../cloud-read-cutover-copy";
import {
  CloudReadCutoverBlocker,
  type CloudReadCutoverDecision,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
} from "../desktop-app-core-mode";

function decision(
  overrides: Partial<CloudReadCutoverDecision> = {}
): CloudReadCutoverDecision {
  return {
    blocker: null,
    cloudHoldsHistory: false,
    deadLetteredCount: 0,
    failedOpen: false,
    itemsRemaining: 0,
    latch: CloudReadCutoverLatch.None,
    mode: DesktopAppCoreMode.Local,
    ...overrides,
  };
}

/**
 * The blockers whose sentence describes a read off a COMPLETE local database.
 * Every one of them owes the user the same reassurance — that is the point of
 * ISS-5477, and it is just as true offline or mid-import as it is mid-drain.
 */
const COMPLETE_LOCAL_READ_BLOCKERS = [
  CloudReadCutoverBlocker.Offline,
  CloudReadCutoverBlocker.ReadinessUnknown,
  CloudReadCutoverBlocker.ImportPending,
  CloudReadCutoverBlocker.SyncDraining,
  CloudReadCutoverBlocker.SyncNotEstablished,
] as const;

/** The tail clause the badge beside the sentence already renders as "Local". */
const RESTATES_WHOSE_DATA = /own machine's data|this device's own data/;

describe("describeCloudReadCutover", () => {
  it("reassures on EVERY local-read state, not only the draining one", () => {
    for (const blocker of COMPLETE_LOCAL_READ_BLOCKERS) {
      const copy = describeCloudReadCutover(
        decision({ blocker, itemsRemaining: 42 })
      );
      expect(copy, `blocker: ${blocker}`).toBeDefined();
      expect(copy, `blocker: ${blocker}`).toContain("Nothing is missing.");
    }
  });

  it("never claims nothing is missing when something genuinely will not arrive", () => {
    const gaveUp = describeCloudReadCutover(
      decision({
        blocker: CloudReadCutoverBlocker.SyncGaveUp,
        deadLetteredCount: 3,
      })
    );
    expect(gaveUp).not.toContain("Nothing is missing");

    const failedOpen = describeCloudReadCutover(
      decision({
        blocker: CloudReadCutoverBlocker.SyncDraining,
        failedOpen: true,
        itemsRemaining: 12,
        latch: CloudReadCutoverLatch.FailedOpen,
        mode: DesktopAppCoreMode.Cloud,
      })
    );
    expect(failedOpen).not.toContain("Nothing is missing");
  });

  it("offers a next step wherever it says work will not reach the workspace", () => {
    const gaveUp = describeCloudReadCutover(
      decision({
        blocker: CloudReadCutoverBlocker.SyncGaveUp,
        deadLetteredCount: 3,
      })
    );
    expect(gaveUp).toContain("Open Diagnostics");

    // The failed-open sentence only names dead letters when there are some, so
    // the next step has to ride along with that clause rather than the state.
    const failedOpenWithDeadLetters = describeCloudReadCutover(
      decision({
        blocker: CloudReadCutoverBlocker.SyncDraining,
        deadLetteredCount: 2,
        failedOpen: true,
        itemsRemaining: 12,
        latch: CloudReadCutoverLatch.FailedOpen,
        mode: DesktopAppCoreMode.Cloud,
      })
    );
    expect(failedOpenWithDeadLetters).toContain(
      "will not appear in your workspace"
    );
    expect(failedOpenWithDeadLetters).toContain("Open Diagnostics");
  });

  it("does not re-explain whose data this is in every string", () => {
    // The badge beside the sentence already says "Local"; the old copy tailed
    // four of six strings with a variant of "this is this device's own data".
    const tails = [
      ...COMPLETE_LOCAL_READ_BLOCKERS,
      CloudReadCutoverBlocker.SyncGaveUp,
    ].map((blocker) =>
      describeCloudReadCutover(decision({ blocker, itemsRemaining: 42 }))
    );
    const restating = tails.filter((copy) =>
      RESTATES_WHOSE_DATA.test(copy ?? "")
    );
    expect(restating).toHaveLength(1);
    // ...and never with the doubled "this".
    for (const copy of tails) {
      expect(copy ?? "").not.toContain("this is this device's own data");
    }
  });

  it("keeps em dashes out of user-facing copy", () => {
    const everyState = [
      ...COMPLETE_LOCAL_READ_BLOCKERS,
      CloudReadCutoverBlocker.SyncGaveUp,
      CloudReadCutoverBlocker.NotAuthenticated,
    ].flatMap((blocker) => [
      describeCloudReadCutover(
        decision({ blocker, deadLetteredCount: 2, itemsRemaining: 42 })
      ),
      describeCloudReadCutover(
        decision({
          blocker,
          deadLetteredCount: 2,
          failedOpen: true,
          itemsRemaining: 42,
          latch: CloudReadCutoverLatch.FailedOpen,
          mode: DesktopAppCoreMode.Cloud,
        })
      ),
      // Review thread: without a `readSource` argument this sweep only ever
      // reaches the local blocker map, so `FALLBACK_SOURCE_UNRESOLVED` and
      // `OFFLINE_CLOUD_CACHE` — both added by this change, both user-facing —
      // sat outside a test whose stated contract is that ALL user-facing copy
      // is clean. Neither carries an em dash today; the point is that nothing
      // would have caught it if one did.
      describeCloudReadCutover(
        decision({ blocker, deadLetteredCount: 2, itemsRemaining: 42 }),
        ReadSource.Fallback
      ),
      describeCloudReadCutover(
        decision({ blocker, deadLetteredCount: 2, itemsRemaining: 42 }),
        ReadSource.Cloud
      ),
    ]);
    for (const copy of everyState) {
      expect(copy ?? "").not.toContain("—");
    }
  });

  it("counts the remainder in the draining sentence", () => {
    expect(
      describeCloudReadCutover(
        decision({
          blocker: CloudReadCutoverBlocker.SyncDraining,
          itemsRemaining: 42,
        })
      )
    ).toBe(
      "Your history is still uploading (42 items to go). Nothing is missing."
    );
  });

  /**
   * ISS-5714 (review thread). A `Fallback` read means NEITHER store answered, so
   * the badge above this sentence already says the view may be incomplete.
   * Left to fall through to the local blocker map, an offline fallback answered
   * "You are offline, so this is your own machine's data. Nothing is missing." —
   * a promise of completeness printed under a badge denying it, about a local
   * read that did not happen. The reassurance IS the defect here, not its
   * wording, so it is asserted absent across every blocker rather than pinned to
   * one string.
   */
  it("never reassures a Fallback reader that nothing is missing", () => {
    const everyBlocker = [
      null,
      ...COMPLETE_LOCAL_READ_BLOCKERS,
      CloudReadCutoverBlocker.SyncGaveUp,
      CloudReadCutoverBlocker.NotAuthenticated,
    ] as const;
    for (const blocker of everyBlocker) {
      const copy = describeCloudReadCutover(
        decision({ blocker, itemsRemaining: 42 }),
        ReadSource.Fallback
      );
      // It says SOMETHING — silence under a warning badge would leave the
      // reader with a tone and no explanation.
      expect(copy).toBeDefined();
      expect(copy ?? "").not.toContain("Nothing is missing");
      // And it does not claim the local database as the source, which is the
      // specific false statement the local map made.
      expect(RESTATES_WHOSE_DATA.test(copy ?? "")).toBe(false);
    }
  });

  it("tells a Fallback reader that dead-lettered work will not arrive", () => {
    // The one fact worth carrying across from the decision: work that was given
    // up on is gone from the workspace whatever store answered.
    const copy = describeCloudReadCutover(
      decision({
        blocker: CloudReadCutoverBlocker.SyncGaveUp,
        deadLetteredCount: 3,
      }),
      ReadSource.Fallback
    );
    expect(copy).toContain("3 items could not be uploaded");
    expect(copy).not.toContain("Nothing is missing");
  });

  it("stays silent when signed out and when there is no blocker", () => {
    expect(
      describeCloudReadCutover(
        decision({ blocker: CloudReadCutoverBlocker.NotAuthenticated })
      )
    ).toBeUndefined();
    expect(describeCloudReadCutover(decision())).toBeUndefined();
  });
});
