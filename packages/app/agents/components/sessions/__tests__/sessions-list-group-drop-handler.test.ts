/**
 * Lock on `resolveGroupDropHandler` (ISS-8296).
 *
 * The handler shipped in #6074 with NO coverage at all — nothing in the repo
 * imported `sessions-list-surface-controls.tsx`. This file pins what it does
 * TODAY, before ISS-8296 threads a canonical band value through it, so the
 * difference between "the drop contract changed on purpose" and "the drop
 * contract broke" is visible in the diff of this file rather than invisible.
 *
 * The two facts worth pinning hardest are the ones ISS-7213 calls layer 2:
 * a handler is produced ONLY when the host actually wired a controller AND
 * that controller admits the field. A capability may narrow those, never widen
 * them.
 */

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { resolveGroupDropHandler } from "../sessions-list-surface-controls";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: toastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const ROW = createSessionTableRowFixture({ id: "session-1" });

function grouping(
  primaryFieldId: string | null,
  secondaryFieldId: string | null = null
): TableGroupingState {
  return {
    primary: {
      fieldId: primaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
    secondary: {
      fieldId: secondaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  };
}

/**
 * A band the producer could map — `value` is the canonical value a host would
 * write, distinct from the `key` it renders.
 *
 * Supplying one is not optional scaffolding: ISS-8296 made the handler refuse a
 * destination with no canonical value, so a band built without one exercises the
 * refusal path rather than the case its test name claims.
 */
function band(
  key: string,
  value = `${key}-id`
): GridTableV2Group<SessionTableRow> {
  return { droppable: true, items: [ROW], key, label: key, value };
}

/** A band the producer could NOT map — the refusal path. */
function unmappableBand(key: string): GridTableV2Group<SessionTableRow> {
  return { droppable: false, items: [ROW], key, label: key };
}

beforeEach(() => {
  toastError.mockClear();
});

describe("resolveGroupDropHandler — layer 2 (host wiring gates the affordance)", () => {
  it("produces NO handler when the host wired no controller", () => {
    expect(
      resolveGroupDropHandler(undefined, grouping("owner"))
    ).toBeUndefined();
  });

  it("produces NO handler when nothing is grouped", () => {
    const onMove = vi.fn();

    expect(
      resolveGroupDropHandler({ canMove: () => true, onMove }, grouping(null))
    ).toBeUndefined();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("produces NO handler when the controller refuses the grouped field", () => {
    const onMove = vi.fn();

    expect(
      resolveGroupDropHandler(
        { canMove: () => false, onMove },
        grouping("owner")
      )
    ).toBeUndefined();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("produces a handler when only the SECONDARY field is movable", () => {
    // davetho review. Gating existence on the primary alone contradicted the
    // renderer, which marks a subgroup droppable from the SECONDARY field: the
    // Status subgroups showed as enabled targets and no `onGroupDrop` existed
    // to receive them.
    expect(
      resolveGroupDropHandler(
        { canMove: (fieldId) => fieldId === "status", onMove: vi.fn() },
        grouping("owner", "status")
      )
    ).toBeTypeOf("function");
  });

  it("still refuses the PRIMARY band when only the secondary is movable", () => {
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: (fieldId) => fieldId === "status", onMove },
      grouping("owner", "status")
    );

    handler?.(ROW, band("Jane Doe", "user-abc"));

    // Widening the gate must not have widened what a drop may WRITE — the
    // per-destination check is what keeps the unadmitted level refused.
    expect(onMove).not.toHaveBeenCalled();
  });

  it("produces a handler when the controller admits the grouped field", () => {
    expect(
      resolveGroupDropHandler(
        { canMove: () => true, onMove: vi.fn() },
        grouping("owner")
      )
    ).toBeTypeOf("function");
  });
});

describe("resolveGroupDropHandler — what reaches onMove today", () => {
  it("reports the PRIMARY field id and the destination band's key", () => {
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner")
    );

    handler?.(ROW, band("Jane Doe", "user-abc"));

    expect(onMove).toHaveBeenCalledTimes(1);
    // The third argument is still the DISPLAY LABEL and the fourth is the
    // canonical value — the two are DIFFERENT strings here on purpose, which is
    // the whole reason ISS-8296 exists. A host reading only the label cannot
    // tell two people named "Jane Doe" apart.
    expect(onMove).toHaveBeenCalledWith(ROW, "owner", "Jane Doe", "user-abc");
  });

  it("reports the SECONDARY field id and the SUBGROUP's key on a subgroup drop", () => {
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner", "status")
    );

    handler?.(ROW, band("Jane Doe", "user-abc"), band("Failed", "error"));

    expect(onMove).toHaveBeenCalledWith(ROW, "status", "Failed", "error");
    // Anti-vacuity, and the specific mis-pairing this guards: `fieldId` comes
    // from the SUBGROUP level, so a value read from the parent band would send
    // the owner id under the status field.
    expect(onMove).not.toHaveBeenCalledWith(
      ROW,
      "status",
      "Failed",
      "user-abc"
    );
    expect(onMove).not.toHaveBeenCalledWith(
      ROW,
      "owner",
      "Jane Doe",
      "user-abc"
    );
  });

  it("refuses a subgroup drop the controller does not admit, and leaves the row alone", () => {
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: (fieldId) => fieldId === "owner", onMove },
      grouping("owner", "status")
    );

    handler?.(ROW, band("Jane Doe"), band("Failed"));

    expect(onMove).not.toHaveBeenCalled();
  });

  it("refuses a destination band the producer could not map", () => {
    // Defence in depth: both renderers already decline such a band, but this is
    // the layer about to call a mutation and it does not take their word for it.
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner")
    );

    handler?.(ROW, unmappableBand("—"));

    expect(onMove).not.toHaveBeenCalled();
  });

  it("passes a PRESENT-but-EMPTY canonical value through rather than dropping it", () => {
    // The unassigned-owner band. `""` is a real, settable destination, and a
    // guard written as `if (!value)` would silently refuse this legal move.
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner")
    );

    handler?.(ROW, band("Unassigned", ""));

    expect(onMove).toHaveBeenCalledWith(ROW, "owner", "Unassigned", "");
  });

  it("refuses a subgroup drop when no secondary field is grouped", () => {
    const onMove = vi.fn();
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner")
    );

    handler?.(ROW, band("Jane Doe"), band("Failed"));

    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("resolveGroupDropHandler — failure reporting", () => {
  it("surfaces a rejected move as a toast rather than an unhandled rejection", async () => {
    const onMove = vi.fn(() => Promise.reject(new Error("nope")));
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner")
    );

    handler?.(ROW, band("Jane Doe"));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));

    expect(toastError).toHaveBeenCalledWith("Couldn't move session");
  });

  it("says nothing when the move resolves", async () => {
    const onMove = vi.fn(() => Promise.resolve());
    const handler = resolveGroupDropHandler(
      { canMove: () => true, onMove },
      grouping("owner")
    );

    handler?.(ROW, band("Jane Doe"));
    await vi.waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));

    expect(toastError).not.toHaveBeenCalled();
  });
});
