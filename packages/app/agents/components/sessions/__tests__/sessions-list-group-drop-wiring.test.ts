/**
 * Lock on `applyGroupDropWiring` (ISS-8296, whitlockk review on #6356).
 *
 * `buildGroups` decides droppability from the canonical value alone — the
 * type-capability layer, and all a pure partition can know. Host wiring is the
 * SECOND layer and it is level-specific, which `resolveGroupDropHandler` is not:
 * that one answers "does a handler exist at all", so it admits one when EITHER
 * level is movable and re-checks the destination's own level once a drop has
 * fired. Nothing exercised that composition, so swapping the gates left green
 * with `canMove("owner")` true and `canMove("status")` false rendered every
 * Status subgroup as an accepting target whose drop silently did nothing.
 *
 * The two levels are therefore wired ASYMMETRICALLY in every case below: each
 * asserts one level accepts and the other refuses, so the swap cannot satisfy
 * both halves of a single case.
 */

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import type { SessionsGroupDropController } from "../sessions-list-interactions";
import { resolveGroupDropHandler } from "../sessions-list-surface-controls";
import { applyGroupDropWiring } from "../sessions-list-surface-model";

const OWNER_FIELD = "owner";
const STATUS_FIELD = "status";

describe("applyGroupDropWiring", () => {
  it("gates the top level on the PRIMARY field, not the secondary one", () => {
    const wired = applyGroupDropWiring(
      [band("Jane Doe", [subband("Failed")])],
      grouping(OWNER_FIELD, STATUS_FIELD),
      controller([OWNER_FIELD])
    );

    // Owner is wired and Status is not, so the owner bands accept and their
    // status subgroups refuse. Swapping the two gates inverts BOTH.
    expect(wired?.[0].droppable).toBe(true);
    expect(wired?.[0].subgroups?.[0].droppable).toBe(false);
  });

  it("gates the nested level on the SECONDARY field, not the primary one", () => {
    const wired = applyGroupDropWiring(
      [band("Jane Doe", [subband("Failed")])],
      grouping(OWNER_FIELD, STATUS_FIELD),
      controller([STATUS_FIELD])
    );

    expect(wired?.[0].droppable).toBe(false);
    expect(wired?.[0].subgroups?.[0].droppable).toBe(true);
  });

  it("only ever narrows — a band the capability already refused stays refused", () => {
    const wired = applyGroupDropWiring(
      [
        {
          ...band("—", [{ ...subband("—"), droppable: false }]),
          droppable: false,
        },
      ],
      grouping(OWNER_FIELD, STATUS_FIELD),
      controller([OWNER_FIELD, STATUS_FIELD])
    );

    // Both fields are wired, so ONLY the capability layer can be refusing here.
    // Host wiring may take a drop target away and must never grant one.
    expect(wired?.[0].droppable).toBe(false);
    expect(wired?.[0].subgroups?.[0].droppable).toBe(false);
  });

  it("refuses every band when the host wired no controller at all", () => {
    const wired = applyGroupDropWiring(
      [band("Jane Doe", [subband("Failed")])],
      grouping(OWNER_FIELD, STATUS_FIELD),
      undefined
    );

    expect(wired?.[0].droppable).toBe(false);
    expect(wired?.[0].subgroups?.[0].droppable).toBe(false);
  });

  it("refuses a level whose grouping field is unset", () => {
    const wired = applyGroupDropWiring(
      [band("Jane Doe", [subband("Failed")])],
      grouping(OWNER_FIELD, null),
      controller([OWNER_FIELD, STATUS_FIELD])
    );

    // No secondary field means there is no field to admit, so the nested level
    // cannot be a target however permissive the controller is.
    expect(wired?.[0].droppable).toBe(true);
    expect(wired?.[0].subgroups?.[0].droppable).toBe(false);
  });

  it("never advertises a target the drop handler will not serve", () => {
    // davetho review: the composition is the contract, not either half.
    // `applyGroupDropWiring` derives each level's `droppable` from ITS OWN
    // field, so if `resolveGroupDropHandler` gated its EXISTENCE on the primary
    // alone, this grouping rendered an enabled Status subgroup and handed
    // `GridTableV2` no `onGroupDrop` at all — a target that swallows the drop.
    const grouped = grouping(OWNER_FIELD, STATUS_FIELD);
    const host = controller([STATUS_FIELD]);
    const wired = applyGroupDropWiring(
      [band("Jane Doe", [subband("Failed")])],
      grouped,
      host
    );

    expect(wired?.[0].subgroups?.[0].droppable).toBe(true);
    // The half that used to be missing: something must actually receive it.
    expect(resolveGroupDropHandler(host, grouped)).toBeTypeOf("function");
  });

  it("still serves no handler when neither configured level can move", () => {
    const grouped = grouping(OWNER_FIELD, STATUS_FIELD);
    const host = controller([]);
    const wired = applyGroupDropWiring(
      [band("Jane Doe", [subband("Failed")])],
      grouped,
      host
    );

    // Both layers refuse together, which is the same agreement pointed the
    // other way — widening the gate must not have made it unconditional.
    expect(wired?.[0].droppable).toBe(false);
    expect(wired?.[0].subgroups?.[0].droppable).toBe(false);
    expect(resolveGroupDropHandler(host, grouped)).toBeUndefined();
  });

  it("passes an ungrouped surface through untouched", () => {
    expect(
      applyGroupDropWiring(
        undefined,
        grouping(OWNER_FIELD, STATUS_FIELD),
        controller([OWNER_FIELD])
      )
    ).toBeUndefined();
  });
});

function grouping(
  primaryFieldId: string | null,
  secondaryFieldId: string | null
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

function controller(movable: readonly string[]): SessionsGroupDropController {
  return {
    canMove: (fieldId: string) => movable.includes(fieldId),
    onMove: () => undefined,
  };
}

function subband(key: string): GridTableV2Group<SessionTableRow> {
  return {
    items: [createSessionTableRowFixture({ id: `session-${key}` })],
    key,
    label: key,
  };
}

function band(
  key: string,
  subgroups: GridTableV2Group<SessionTableRow>[]
): GridTableV2Group<SessionTableRow> {
  return {
    items: [createSessionTableRowFixture({ id: `session-${key}` })],
    key,
    label: key,
    subgroups,
  };
}
