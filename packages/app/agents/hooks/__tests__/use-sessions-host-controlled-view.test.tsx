import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DATE_RANGE } from "../../../shared/lib/format-utils";
import type {
  SessionsCustomFieldFilters,
  SessionsCustomFieldsController,
} from "../../components/sessions/sessions-list-custom-fields";
import { sessionsCustomFieldColumnId } from "../../components/sessions/sessions-list-custom-fields";
import type { SessionsListViewState } from "../../components/sessions/sessions-list-view-state";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../lib/session-filter-adapter";
import { SessionGroupBy } from "../../lib/session-grouping";
import { SessionSortDir } from "../../lib/session-sort-group";
import { SessionsListReadState } from "../../lib/sessions-list-read-state";
import type { SessionsHostViewState } from "../../lib/sessions-list-view-adapter";
import { useSessionsHostControlledView } from "../use-sessions-host-controlled-view";

/**
 * ISS-12455 — the host-local half of the Sessions view state, shared by every
 * shell that mounts `SessionsListSurfaceV2`.
 *
 * The reconcilers themselves are covered in
 * `lib/__tests__/sessions-list-view-adapter.test.ts`. What is pinned here is the
 * COMPOSITION a host used to hand-write and the desktop host got wrong: that the
 * controlled `value` the surface renders from carries the custom-field columns
 * the host's persisted vocabulary cannot represent, and that a View-menu toggle
 * removing one is remembered rather than erased by `toSessionsHostViewState` on
 * the very next render.
 */

const FIELD: CustomFieldWithOptions = {
  id: "field-1",
  organizationId: "org-1",
  name: "Squad",
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: true,
  entityTypes: [CustomFieldEntityType.Session],
  referenceTargetSources: [],
  showInTable: true,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

const FIELD_COLUMN_ID = sessionsCustomFieldColumnId(FIELD.id);

const CONTROLLER: SessionsCustomFieldsController = {
  fields: [FIELD],
  valuesBySessionId: new Map(),
};

const HOST_VIEW: SessionsHostViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  groupBy: SessionGroupBy.None,
  page: 0,
  scopeUserId: null,
  search: "",
  secondarySorts: [],
  sortDir: SessionSortDir.Desc,
  sortKey: null,
  visibleColumns: new Set(["name", "status"]),
};

function renderControlledView(
  customFields: SessionsCustomFieldsController | undefined = CONTROLLER
) {
  const onHostViewChange = vi.fn();
  const rendered = renderHook(() =>
    useSessionsHostControlledView({
      customFields,
      hostView: HOST_VIEW,
      listReadState: SessionsListReadState.Settled,
      onHostViewChange,
      total: 1,
    })
  );
  return { onHostViewChange, rendered };
}

/** The surface's own report after a reader unticks `columnId` in the View menu. */
function viewWithColumnHidden(
  value: SessionsListViewState,
  columnId: string
): SessionsListViewState {
  const visibleColumnIds = new Set(value.visibleColumnIds);
  visibleColumnIds.delete(columnId);
  return { ...value, visibleColumnIds };
}

describe("useSessionsHostControlledView", () => {
  it("rejoins the custom-field columns onto the host's persisted set", () => {
    const { rendered } = renderControlledView();

    expect([
      ...rendered.result.current.controlledView.value.visibleColumnIds,
    ]).toContain(FIELD_COLUMN_ID);
  });

  it("offers no column for a field the org keeps out of the table", () => {
    const { rendered } = renderControlledView({
      ...CONTROLLER,
      fields: [{ ...FIELD, showInTable: false }],
    });

    expect([
      ...rendered.result.current.controlledView.value.visibleColumnIds,
    ]).not.toContain(FIELD_COLUMN_ID);
  });

  it("keeps a custom column hidden after a View-menu toggle turns it off", () => {
    const { onHostViewChange, rendered } = renderControlledView();
    const { controlledView } = rendered.result.current;

    act(() => {
      controlledView.onChange(
        viewWithColumnHidden(controlledView.value, FIELD_COLUMN_ID)
      );
    });

    // The toggle is only honoured if the NEXT value still omits the id. Before
    // this store existed the host rebuilt `value` from `toSessionsListViewState`
    // alone, so the column came straight back on the following render.
    expect([
      ...rendered.result.current.controlledView.value.visibleColumnIds,
    ]).not.toContain(FIELD_COLUMN_ID);
    // FEA-4222: and the id must NOT reach the host, whose `toggleColumn` would
    // persist an unrepresentable id into the saved view's hidden set forever.
    const reported: SessionsHostViewState = onHostViewChange.mock.calls[0][0];
    expect([...reported.visibleColumns]).not.toContain(FIELD_COLUMN_ID);
  });

  it("shows the hidden custom column again after a reset", () => {
    const { rendered } = renderControlledView();

    act(() => {
      const { controlledView } = rendered.result.current;
      controlledView.onChange(
        viewWithColumnHidden(controlledView.value, FIELD_COLUMN_ID)
      );
    });
    act(() => {
      rendered.result.current.resetLocalView();
    });

    expect([
      ...rendered.result.current.controlledView.value.visibleColumnIds,
    ]).toContain(FIELD_COLUMN_ID);
  });

  it("carries the custom-field facet selections the host cannot represent", () => {
    const { rendered } = renderControlledView();
    const customFieldFilters: SessionsCustomFieldFilters = new Map([
      [FIELD_COLUMN_ID, { kind: "options", selectedValues: ["platform"] }],
    ]);

    act(() => {
      const { controlledView } = rendered.result.current;
      controlledView.onChange({ ...controlledView.value, customFieldFilters });
    });

    // ISS-8216: a `custom-field:*` id has no slot in the host's closed facet
    // vocabulary, so a facet the store did not hold would tick and un-tick on
    // the next render.
    expect(
      rendered.result.current.controlledView.value.customFieldFilters?.get(
        FIELD_COLUMN_ID
      )
    ).toEqual({ kind: "options", selectedValues: ["platform"] });
  });

  it("keeps the host's grouping sub-level while the persisted primary agrees", () => {
    const { rendered } = renderControlledView();
    const grouping = {
      ...EMPTY_TABLE_GROUPING,
      secondary: { ...EMPTY_TABLE_GROUPING.secondary, fieldId: "harness" },
    };

    act(() => {
      const { controlledView } = rendered.result.current;
      controlledView.onChange({ ...controlledView.value, grouping });
    });

    expect(
      rendered.result.current.controlledView.value.grouping.secondary.fieldId
    ).toBe("harness");
  });

  it("keeps the same view when the surface re-reports the value it was given", () => {
    const { rendered } = renderControlledView();
    const { controlledView } = rendered.result.current;

    act(() => {
      controlledView.onChange(controlledView.value);
    });

    // A fresh object here re-renders the surface, which reports again during a
    // render-driven repair and loops until React aborts ("Maximum update depth
    // exceeded" in sessions-view-empty-states.test.tsx).
    expect(rendered.result.current.controlledView).toBe(controlledView);
  });
});
