import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import type { SyncedBranchLifecycleEvent } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { mergeBranchLifecycleEvents } from "./shared";

describe("mergeBranchLifecycleEvents ordering", () => {
  it("sorts evidenceless events strictly ascending by observedAt even when given in reverse order", () => {
    const latest: SyncedBranchLifecycleEvent = {
      kind: BranchLifecycleBoundaryKind.PrRaised,
      observedAt: "2026-05-20T18:00:00.000Z",
    };
    const middle: SyncedBranchLifecycleEvent = {
      kind: BranchLifecycleBoundaryKind.BranchWrite,
      observedAt: "2026-05-20T17:00:00.000Z",
    };
    const earliest: SyncedBranchLifecycleEvent = {
      kind: BranchLifecycleBoundaryKind.SessionStart,
      observedAt: "2026-05-20T16:00:00.000Z",
    };

    const merged = mergeBranchLifecycleEvents([latest, middle, earliest]);

    expect(merged.map((event) => event.kind)).toEqual([
      BranchLifecycleBoundaryKind.SessionStart,
      BranchLifecycleBoundaryKind.BranchWrite,
      BranchLifecycleBoundaryKind.PrRaised,
    ]);
  });

  it("sorts an event with an unparseable observedAt after one with a real timestamp", () => {
    const valid: SyncedBranchLifecycleEvent = {
      kind: BranchLifecycleBoundaryKind.SessionStart,
      observedAt: "2026-05-20T16:00:00.000Z",
    };
    const unparseable: SyncedBranchLifecycleEvent = {
      kind: BranchLifecycleBoundaryKind.PrRaised,
      observedAt: "not-a-real-date",
    };

    const merged = mergeBranchLifecycleEvents([unparseable, valid]);

    expect(merged.map((event) => event.kind)).toEqual([
      BranchLifecycleBoundaryKind.SessionStart,
      BranchLifecycleBoundaryKind.PrRaised,
    ]);
  });
});
