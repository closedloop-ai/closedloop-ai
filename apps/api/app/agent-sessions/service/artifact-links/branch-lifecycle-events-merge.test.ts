import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import { MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { mergeBranchLifecycleEvents } from "./shared";

/*
 * The pure merge/retention contract for branch lifecycle boundaries, split out
 * of `branch-links.test.ts` (ISS-8247). These drive `mergeBranchLifecycleEvents`
 * directly and need none of that file's ingest harness or database mocks, so
 * they are their own responsibility — and that file is over the size ceiling.
 *
 * ISS-8247 removed the newest-N window these used to assert: every boundary the
 * wire schema ACCEPTED is now stored, because a window on an already-acknowledged
 * payload cannot report what it discarded. The stored-set-after-a-real-sync half
 * stays in `branch-links.test.ts`, which owns the ingest path.
 */
describe("mergeBranchLifecycleEvents", () => {
  it("persists every accepted lifecycle event rather than the newest 50 (ISS-8247)", () => {
    const events = Array.from(
      { length: MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS + 2 },
      (_, index) => ({
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
        evidenceId: `desktop-artifact-link:${index}`,
      })
    );

    const merged = mergeBranchLifecycleEvents(events);

    // The window this replaces clipped the OLDEST two boundaries off a payload
    // the wire schema had already accepted and acknowledged.
    expect(merged).toHaveLength(MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS + 2);
    expect(merged[0]?.evidenceId).toBe("desktop-artifact-link:0");
    expect(merged.at(-1)?.evidenceId).toBe(
      `desktop-artifact-link:${MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS + 1}`
    );
  });

  it("replaces an earlier lifecycle event with the same evidenceId (FEA-3851 method correction)", () => {
    // A reviewed-PR boundary first synced as ReviewFeedback, then the desktop
    // extractor corrects the method and re-syncs the SAME boundary (same
    // evidenceId) as a read-only reference. The corrected (later) event must
    // REPLACE the stale one, not sit beside it.
    const stale = {
      kind: BranchLifecycleBoundaryKind.ReviewFeedback,
      observedAt: "2026-07-01T00:00:00.000Z",
      evidenceId: "desktop-artifact-link:l-42",
    };
    const corrected = {
      kind: BranchLifecycleBoundaryKind.ReadOnlyReference,
      observedAt: "2026-07-01T00:00:00.000Z",
      evidenceId: "desktop-artifact-link:l-42",
    };

    const merged = mergeBranchLifecycleEvents([stale], [corrected]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe(BranchLifecycleBoundaryKind.ReadOnlyReference);
    expect(
      merged.some(
        (event) => event.kind === BranchLifecycleBoundaryKind.ReviewFeedback
      )
    ).toBe(false);
  });

  it("keeps distinct evidence-less lifecycle events even when kinds differ", () => {
    // Evidence-less events have no durable id, so they must fall back to the
    // composite-key dedupe and not collapse into one another.
    const readOnly = {
      kind: BranchLifecycleBoundaryKind.ReadOnlyReference,
      observedAt: "2026-07-01T00:00:00.000Z",
    };
    const feedback = {
      kind: BranchLifecycleBoundaryKind.ReviewFeedback,
      observedAt: "2026-07-01T00:00:00.000Z",
    };

    const merged = mergeBranchLifecycleEvents([readOnly], [feedback]);

    expect(merged).toHaveLength(2);
  });

  /*
   * #7204 review (davetho): `evidenceId` is optional, so two accepted events
   * sharing a `kind` and a missing-or-equal `observedAt` collapse to one. That
   * collapse is the CONTRACT, not an oversight — such a pair is indistinguishable
   * in the payload, so retaining multiplicity would make a re-sync of the SAME
   * evidence-less boundary append a copy on every poll, growing the (now
   * unbounded) stored array with poll volume. These two cases pin both halves so
   * neither can be "fixed" into the other by accident.
   */
  it("is idempotent for an evidence-less boundary re-synced unchanged", () => {
    const boundary = {
      kind: BranchLifecycleBoundaryKind.BranchWrite,
      observedAt: "2026-07-01T00:00:00.000Z",
    };

    // The same payload arriving on a second sync, as a poll loop produces.
    const merged = mergeBranchLifecycleEvents([boundary], [{ ...boundary }]);

    expect(merged).toHaveLength(1);
  });

  it("keeps evidence-less boundaries that differ in observedAt", () => {
    // The dedupe is composite, not kind-only: two BranchWrites the producer
    // actually timestamped differently are distinguishable and both survive.
    const merged = mergeBranchLifecycleEvents([
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: "2026-07-01T00:05:00.000Z",
      },
    ]);

    expect(merged).toHaveLength(2);
  });

  it("orders lifecycle events deterministically with ties and missing timestamps", () => {
    const events = [
      ...Array.from(
        { length: MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS },
        (_, index) => ({
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
          evidenceId: `desktop-artifact-link:${index}`,
        })
      ),
      {
        kind: BranchLifecycleBoundaryKind.ReviewFeedback,
        observedAt: new Date(
          Date.UTC(2026, 6, 1, 0, MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS - 1)
        ).toISOString(),
        evidenceId: "desktop-artifact-link:tie",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        evidenceId: "desktop-artifact-link:no-time-b",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        evidenceId: "desktop-artifact-link:no-time-a",
      },
    ];

    const merged = mergeBranchLifecycleEvents(events);

    // 50 indexed + one same-minute tie + two timestamp-less boundaries.
    expect(merged).toHaveLength(MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS + 3);
    // ISS-8247: the three oldest, which the newest-N window used to discard.
    expect(merged[0]?.evidenceId).toBe("desktop-artifact-link:0");
    expect(
      merged.some((event) => event.evidenceId === "desktop-artifact-link:1")
    ).toBe(true);
    expect(
      merged.some((event) => event.evidenceId === "desktop-artifact-link:2")
    ).toBe(true);
    expect(merged.at(-2)?.evidenceId).toBe("desktop-artifact-link:no-time-a");
    expect(merged.at(-1)?.evidenceId).toBe("desktop-artifact-link:no-time-b");
  });
});
