import type {
  CustomFieldEnumOption,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  EMPTY_TABLE_GROUPING,
  TableSavedViewScope,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionTableRowFixture,
  SESSION_FIXTURE_NOW_MS,
} from "../session-list-fixtures";
import {
  type SessionsCustomFieldFilters,
  type SessionsCustomFieldsController,
  sessionsCustomFieldColumnId,
} from "../sessions-list-custom-fields";
import type {
  SessionsSavedView,
  SessionsSavedViewsController,
} from "../sessions-list-saved-views";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-8216 — saved views carry the custom-field filter axis.
 *
 * `customFieldFilters` used to be a `useState` beside the view state rather than
 * part of it, so a saved view saved and reapplied every other axis and left this
 * one alone: picking a view after filtering by a custom field left the list
 * still narrowed by a filter the view did not represent (whitlockk, #6074).
 *
 * Every case asserts the RENDERED ROWS. A saved view "containing" the filter is
 * satisfied by a value nothing ever applies, and the reported view state was
 * never the thing that was wrong — which rows survive is.
 */

const STAGE_FIELD_ID = "stage";
const STAGE_COLUMN_ID = sessionsCustomFieldColumnId(STAGE_FIELD_ID);
/** The Enum facet keys on the option's NAME — see `customFieldFilterValues`. */
const STAGE_BUILD_VALUE = "Build";

const FILTERED_IN_ROW_NAME = "agent/stage-build";
const FILTERED_OUT_ROW_NAME = "agent/no-stage";

const VIEWS_TRIGGER_NAME = "Views";
const SAVE_ITEM_NAME = "Save current view";
const SAVE_BUTTON_NAME = "Save view";
const NAME_INPUT_NAME = "View name";

/** A view stored before this axis existed: no `customFieldFilters` key at all. */
const PRE_AXIS_VIEW_NAME = "Everything";
const STAGE_VIEW_NAME = "Building";
const ROUND_TRIP_VIEW_NAME = "Mine";

const FIXED_DATE = new Date("2026-08-25T12:00:00.000Z");

const STAGE_BUILD_OPTION: CustomFieldEnumOption = {
  color: "#64748b",
  customFieldId: STAGE_FIELD_ID,
  enabled: true,
  id: "stage-build",
  name: STAGE_BUILD_VALUE,
  sortOrder: 0,
};

const STAGE_FIELD: CustomFieldWithOptions = {
  createdAt: FIXED_DATE,
  createdById: "test-user",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [STAGE_BUILD_OPTION],
  fieldType: CustomFieldType.Enum,
  id: STAGE_FIELD_ID,
  isGlobalToOrg: false,
  isSearchable: true,
  isSortable: false,
  name: "Stage",
  numberFormat: null,
  organizationId: "test-org",
  precision: null,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: FIXED_DATE,
};

const STAGE_VALUE: CustomFieldValueDetail = {
  customFieldId: STAGE_FIELD_ID,
  dateValue: null,
  displayValue: STAGE_BUILD_VALUE,
  entityId: "ses-build",
  enumValue: STAGE_BUILD_OPTION,
  fieldType: CustomFieldType.Enum,
  id: "ses-build-stage",
  multiEnumValues: [],
  name: STAGE_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};

/** Only the first row carries a Stage value, so the facet narrows to it. */
const CUSTOM_FIELDS: SessionsCustomFieldsController = {
  fields: [STAGE_FIELD],
  valuesBySessionId: new Map([["ses-build", [STAGE_VALUE]]]),
};

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({ id: "ses-build", name: FILTERED_IN_ROW_NAME }),
  createSessionTableRowFixture({
    id: "ses-plain",
    name: FILTERED_OUT_ROW_NAME,
  }),
];

const STAGE_BUILD_FILTERS: SessionsCustomFieldFilters = new Map([
  [STAGE_COLUMN_ID, { kind: "options", selectedValues: [STAGE_BUILD_VALUE] }],
]);

/**
 * One visible data column, for the reason the sibling controlled-view suite
 * gives: this surface mounts a toolbar, four menus and the summary strip, so
 * every extra column is paid for on a mount that is already expensive.
 */
const BASE_VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  sortBy: null,
  sortDir: "asc",
  visibleColumnIds: new Set(["status"]),
};

const PRE_AXIS_SAVED_VIEW: SessionsSavedView = {
  id: "pre-axis",
  name: PRE_AXIS_VIEW_NAME,
  scope: TableSavedViewScope.Personal,
  value: BASE_VIEW,
};

const STAGE_SAVED_VIEW: SessionsSavedView = {
  id: "stage",
  name: STAGE_VIEW_NAME,
  scope: TableSavedViewScope.Personal,
  value: { ...BASE_VIEW, customFieldFilters: STAGE_BUILD_FILTERS },
};

/**
 * A host that actually stores what the surface reports — the only shape that can
 * observe this defect. Against a `vi.fn()` onChange the surface never moves, so
 * the rows never change and every assertion below would read the seed.
 */
function SavedViewHost({
  customFields = CUSTOM_FIELDS,
  initialView,
  initialViews,
}: {
  customFields?: SessionsCustomFieldsController;
  initialView: SessionsListViewState;
  initialViews: readonly SessionsSavedView[];
}) {
  const [view, setView] = useState(initialView);
  const [views, setViews] = useState(initialViews);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const savedViews: SessionsSavedViewsController = {
    activeViewId,
    onApply: setActiveViewId,
    onSave: (name, value) => {
      setViews((current) => [
        ...current,
        { id: name, name, scope: TableSavedViewScope.Personal, value },
      ]);
      setActiveViewId(name);
    },
    views,
  };
  return (
    <SessionsListSurfaceV2
      controlledView={{ onChange: setView, value: view }}
      customFields={customFields}
      pageSize={10}
      rows={ROWS}
      savedViews={savedViews}
      usage={undefined}
    />
  );
}

/** Radix opens on `pointerdown`, not `click`. */
function openViewsMenu(triggerName: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), {
    button: 0,
    ctrlKey: false,
  });
}

function applySavedView(triggerName: string, viewName: string) {
  openViewsMenu(triggerName);
  fireEvent.click(screen.getByRole("menuitem", { name: viewName }));
}

/** The rendered session names, which is what every case below is about. */
function renderedRowNames(): string[] {
  return [FILTERED_IN_ROW_NAME, FILTERED_OUT_ROW_NAME].filter(
    (name) => screen.queryByText(name) !== null
  );
}

const NARROWED_TO_STAGE_BUILD = [FILTERED_IN_ROW_NAME];
const EVERY_ROW = [FILTERED_IN_ROW_NAME, FILTERED_OUT_ROW_NAME];

let restoreContainerWidth: (() => void) | null = null;

/**
 * An EXPLICIT budget rather than the runner's 5 s default. Each case below
 * mounts the whole surface — toolbar, four menus, the summary strip — and the
 * heaviest drives three dropdowns and a dialog on top; measured at 4.5 s on a
 * warm tree, it crossed the default under host load and failed on the clock
 * rather than on its assertion. The sibling controlled-view suite records the
 * same 6.5 s overrun for the same reason.
 */
const CASE_TIMEOUT_MS = 20_000;

/**
 * The fixture rows carry a FIXED past start instant, so against the wall clock
 * they age out of the default window and every mount renders an empty table —
 * a saved-view test failing on the calendar. Only `Date` is faked, so React's
 * scheduler and the surface's own interval keep real timers.
 */
beforeEach(() => {
  restoreContainerWidth = stubContainerWidthPx(1440);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SESSION_FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 saved views and custom-field filters", () => {
  /**
   * THE ticket's scenario, and the version-skew case in the same run: the stored
   * view has no `customFieldFilters` key at all, because it was written by a
   * build that had no such axis. Applying it must leave the list unnarrowed — an
   * absent key is a view that represents no custom-field filter, never one that
   * silently endorses whichever filter is already live.
   */
  it(
    "stops narrowing by a filter the applied view does not represent",
    () => {
      render(
        <SavedViewHost
          initialView={{
            ...BASE_VIEW,
            customFieldFilters: STAGE_BUILD_FILTERS,
          }}
          initialViews={[PRE_AXIS_SAVED_VIEW]}
        />
      );

      expect(renderedRowNames()).toEqual(NARROWED_TO_STAGE_BUILD);

      applySavedView(VIEWS_TRIGGER_NAME, PRE_AXIS_VIEW_NAME);

      expect(renderedRowNames()).toEqual(EVERY_ROW);
    },
    CASE_TIMEOUT_MS
  );

  /**
   * The positive sibling: a view that DOES carry the axis re-applies it, which
   * is the behavior a reader expects from a named view and the reason this
   * ticket saves rather than clears.
   *
   * The precondition is also the third state the axis has to keep apart from the
   * other two — the seed view's key is ABSENT while custom fields exist, and an
   * absent key must render as no filter rather than throwing or narrowing.
   */
  it(
    "restores the custom-field filter a saved view carries",
    () => {
      render(
        <SavedViewHost
          initialView={BASE_VIEW}
          initialViews={[STAGE_SAVED_VIEW]}
        />
      );

      expect(renderedRowNames()).toEqual(EVERY_ROW);

      applySavedView(VIEWS_TRIGGER_NAME, STAGE_VIEW_NAME);

      expect(renderedRowNames()).toEqual(NARROWED_TO_STAGE_BUILD);
    },
    CASE_TIMEOUT_MS
  );

  /**
   * The field the view was saved against is GONE — deleted, or un-shown in the
   * table, so `buildSessionsCustomFieldColumns` yields no column for it (codex
   * review PRRT_kwDOQ4gDpM6d4V-c / PRRT_kwDOQ4gDpM6d4czZ).
   *
   * Only ISS-8216 makes this reachable: the axis used to die with the mount, and
   * now a stored view can carry a selection that outlives its field. Unresolved,
   * the row filter matched NOTHING — `customFieldForColumn` returns undefined,
   * no row value carries a matching id — while the facet builder emitted no
   * group and the chip bar no chip: an empty table, no stated reason, and no
   * control to undo it. It must narrow nothing instead.
   *
   * The active-filters bar must stay away too — its "Clear all" is what the
   * sibling case above proves this axis raises. Offering to clear a filter the
   * reader can neither see nor have felt is the same lie in the other direction,
   * and it is exactly what a fix applied only to the row filter would leave.
   */
  it(
    "ignores a saved filter whose custom field no longer exists",
    () => {
      render(
        <SavedViewHost
          customFields={{ fields: [], valuesBySessionId: new Map() }}
          initialView={BASE_VIEW}
          initialViews={[STAGE_SAVED_VIEW]}
        />
      );

      applySavedView(VIEWS_TRIGGER_NAME, STAGE_VIEW_NAME);

      expect(renderedRowNames()).toEqual(EVERY_ROW);
      expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    },
    CASE_TIMEOUT_MS
  );

  /**
   * "Clear all" is `clearAllFilters()` followed by one `onToggle` per selected
   * value, synchronously with no render between (`ActiveFiltersBar`'s
   * `clearHostFacet`). A toggle deciding direction from the state its
   * predecessor just emptied finds the value ABSENT and puts it back — the
   * second of the two failure modes `applyFacetToggle` documents, reached by the
   * custom-field facet through the same route the built-in ones did.
   *
   * Asserted on rows: a re-added filter still narrows the list, which is the
   * defect. The chip disappearing for a frame is not.
   */
  it(
    "clears an active custom-field filter through Clear all",
    () => {
      render(
        <SavedViewHost
          initialView={{
            ...BASE_VIEW,
            customFieldFilters: STAGE_BUILD_FILTERS,
          }}
          initialViews={[]}
        />
      );

      expect(renderedRowNames()).toEqual(NARROWED_TO_STAGE_BUILD);

      fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

      expect(renderedRowNames()).toEqual(EVERY_ROW);
    },
    CASE_TIMEOUT_MS
  );

  /**
   * The round trip through the toolbar's own Save dialog, which is the only path
   * that proves the SAVE side: a view saved while a custom-field filter is live
   * must reapply that filter after another view has cleared it.
   */
  it(
    "saves the live custom-field filter into a new view and reapplies it",
    () => {
      render(
        <SavedViewHost
          initialView={{
            ...BASE_VIEW,
            customFieldFilters: STAGE_BUILD_FILTERS,
          }}
          initialViews={[PRE_AXIS_SAVED_VIEW]}
        />
      );

      openViewsMenu(VIEWS_TRIGGER_NAME);
      fireEvent.click(screen.getByRole("menuitem", { name: SAVE_ITEM_NAME }));
      fireEvent.change(screen.getByRole("textbox", { name: NAME_INPUT_NAME }), {
        target: { value: ROUND_TRIP_VIEW_NAME },
      });
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_NAME }));

      // Saving does not change what is on screen; the trigger now names the view.
      expect(renderedRowNames()).toEqual(NARROWED_TO_STAGE_BUILD);

      applySavedView(ROUND_TRIP_VIEW_NAME, PRE_AXIS_VIEW_NAME);
      expect(renderedRowNames()).toEqual(EVERY_ROW);

      applySavedView(PRE_AXIS_VIEW_NAME, ROUND_TRIP_VIEW_NAME);
      expect(renderedRowNames()).toEqual(NARROWED_TO_STAGE_BUILD);
    },
    CASE_TIMEOUT_MS
  );
});
