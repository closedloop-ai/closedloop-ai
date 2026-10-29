import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_RANGE } from "../../../../shared/lib/format-utils";
import type { SessionFacetFilters } from "../../../lib/session-filter-adapter";
import { OWNER_COLUMN_ID } from "../../../lib/session-sort-group";
import { SESSIONS_STATUS_COLUMN_ID } from "../../../lib/sessions-table-columns";
import type { SessionsCustomFieldFilter } from "../sessions-list-custom-fields";
import { resolveSessionsFiltersActive } from "../sessions-list-surface-model";
import type { SessionsListViewState } from "../sessions-list-view-state";
import {
  deserializeSessionsListViewState,
  SESSIONS_VIEW_STATE_AXES,
  serializeSessionsListViewState,
} from "../sessions-list-view-state-serialization";
import { resolveHiddenSummaryCardIds } from "../sessions-summary-card-visibility";

/**
 * ISS-8693 — `SessionsListViewState` carries `Set` axes, and `JSON.stringify`
 * turns a `Set` (and a `Map`) into `{}` with no error, so a view persisted raw
 * restores as "no filters" and quietly shows everything.
 *
 * Every fixture below is spelled out as an independent literal rather than
 * derived from the module under test: an expectation built from
 * `SESSIONS_VIEW_STATE_AXES` or from the serializer's own output cannot fail on
 * the mutation it exists to catch.
 */

/**
 * A `Map` axis a LATER build names and this one does not, which is how a
 * desktop build one release behind sees an axis the web build already writes.
 *
 * Deliberately a name no axis will ever carry: it stands in for the next
 * `SessionsListViewState` field rather than predicting it, so the forward-compat
 * path keeps its coverage when that field actually lands and becomes declared
 * (as `customFieldFilters` did).
 */
const FORWARD_MAP_AXIS = "axisFromANewerBuild";

const GROUPING: TableGroupingState = {
  primary: {
    fieldId: SESSIONS_STATUS_COLUMN_ID,
    order: TableGroupOrder.Custom,
    showEmptyGroups: false,
  },
  secondary: {
    fieldId: null,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: true,
  },
};

type ViewStateWithForwardAxis = SessionsListViewState & {
  [FORWARD_MAP_AXIS]: ReadonlyMap<string, readonly string[]>;
};

function buildView(): ViewStateWithForwardAxis {
  return {
    [FORWARD_MAP_AXIS]: new Map([
      ["tier", ["gold", "silver"]],
      ["squad", ["platform"]],
    ]),
    customFieldFilters: new Map<string, SessionsCustomFieldFilter>([
      ["custom-field:tier", { kind: "options", selectedValues: ["gold"] }],
      ["custom-field:budget", { kind: "range", max: 90, min: 10 }],
    ]),
    dateRange: "30d",
    facets: {
      autonomyTiers: ["supervised"],
      changePresence: [],
      costBuckets: [],
      harnesses: ["claude"],
      models: [],
      prAssociation: [],
      projectIds: [],
      repositories: ["closedloop-ai/closedloop-ai"],
      statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ERROR],
      userIds: ["user-1", "user-2"],
    },
    grouping: GROUPING,
    hiddenSummaryCardIds: new Set(["cost", "tokens"]),
    page: 4,
    scopeUserId: "user-9",
    search: "deploy-pipeline",
    sortBy: OWNER_COLUMN_ID,
    sortDir: "desc",
    sorts: [
      { direction: "desc", fieldId: OWNER_COLUMN_ID },
      { direction: "asc", fieldId: SESSIONS_STATUS_COLUMN_ID },
    ],
    visibleColumnIds: new Set([SESSIONS_STATUS_COLUMN_ID, OWNER_COLUMN_ID]),
  };
}

/** Push a serialized payload through the real boundary the axes have to cross. */
function acrossJson(serialized: unknown): unknown {
  return JSON.parse(JSON.stringify(serialized));
}

describe("PRD-721 AC-5 / DT-FS-11 sessions view-state serialization", () => {
  it("round-trips the whole view state, Set and Map axes included", () => {
    const view = buildView();

    const restored = deserializeSessionsListViewState(
      acrossJson(serializeSessionsListViewState(view))
    );

    // The WHOLE object, not axis by axis: a key-by-key assertion is satisfied
    // by a payload that dropped whichever axis it did not name.
    expect(restored).toStrictEqual(buildView());
  });

  /**
   * ISS-8966: `search` is declared NON-required for exactly this payload — a
   * view saved by any build before the axis existed. A missing REQUIRED axis
   * makes `deserializeSessionsListViewState` return `null`, which callers read
   * as "no saved view", so declaring it required would have silently deleted
   * every reader's stored view on the first restore after this shipped.
   *
   * The rest of the view is asserted too, not just the `null` check: a restore
   * that survived but dropped the other axes would be the same loss wearing a
   * different shape.
   */
  it("restores a view stored before the search axis existed", () => {
    const serialized = serializeSessionsListViewState(buildView());
    Reflect.deleteProperty(serialized, "search");

    const restored = deserializeSessionsListViewState(acrossJson(serialized));

    expect(restored).not.toBeNull();
    expect(restored?.search).toBeUndefined();
    expect(restored?.facets).toStrictEqual(buildView().facets);
    expect(restored?.visibleColumnIds).toStrictEqual(
      buildView().visibleColumnIds
    );
  });

  it("emits a payload JSON leaves unchanged", () => {
    const serialized = serializeSessionsListViewState(buildView());

    expect(acrossJson(serialized)).toStrictEqual(serialized);
  });

  it("keeps an absent axis absent, distinct from empty and from applied", () => {
    const applied = buildView();
    const empty: ViewStateWithForwardAxis = {
      ...applied,
      hiddenSummaryCardIds: new Set(),
    };
    const absent: ViewStateWithForwardAxis = { ...applied };
    absent.hiddenSummaryCardIds = undefined;

    const restoredApplied = deserializeSessionsListViewState(
      acrossJson(serializeSessionsListViewState(applied))
    );
    const restoredEmpty = deserializeSessionsListViewState(
      acrossJson(serializeSessionsListViewState(empty))
    );
    const restoredAbsent = deserializeSessionsListViewState(
      acrossJson(serializeSessionsListViewState(absent))
    );

    expect(restoredApplied?.hiddenSummaryCardIds).toStrictEqual(
      new Set(["cost", "tokens"])
    );
    expect(restoredEmpty?.hiddenSummaryCardIds).toStrictEqual(new Set());
    expect(restoredAbsent?.hiddenSummaryCardIds).toBeUndefined();
    // Absent is not merely a different value — it is the one answer that lets
    // the host's own hidden set stand, so collapsing it into empty would hide
    // nothing where the host hides two cards.
    const hostHidden = new Set(["prs-shipped"]);
    expect(
      resolveHiddenSummaryCardIds(
        restoredAbsent?.hiddenSummaryCardIds,
        hostHidden
      )
    ).toBe(hostHidden);
    expect(
      resolveHiddenSummaryCardIds(
        restoredEmpty?.hiddenSummaryCardIds,
        hostHidden
      )
    ).toStrictEqual(new Set());
  });

  it("does not write an absent axis into the payload", () => {
    const absent = buildView();
    absent.hiddenSummaryCardIds = undefined;
    absent.sorts = undefined;

    const serialized = serializeSessionsListViewState(absent);

    expect(Object.hasOwn(serialized, "hiddenSummaryCardIds")).toBe(false);
    expect(Object.hasOwn(serialized, "sorts")).toBe(false);
  });

  it("names every axis the view state carries", () => {
    // An independent literal, so an axis added to `SessionsListViewState`
    // without a serialization decision fails here as well as at `tsc`.
    expect([...Object.keys(SESSIONS_VIEW_STATE_AXES)].sort()).toStrictEqual([
      "customFieldFilters",
      "dateRange",
      "facets",
      "grouping",
      "hiddenSummaryCardIds",
      "page",
      "scopeUserId",
      "search",
      "sortBy",
      "sortDir",
      "sorts",
      "visibleColumnIds",
    ]);
  });

  it("refuses a payload that is not a view state without throwing", () => {
    // `undefined` is what an unset storage key parses to, and it is the one
    // input that reaches this function with no keys to enumerate at all.
    expect(deserializeSessionsListViewState(undefined)).toBeNull();
    expect(deserializeSessionsListViewState(null)).toBeNull();
    expect(deserializeSessionsListViewState("{}")).toBeNull();
    expect(deserializeSessionsListViewState([])).toBeNull();
  });

  it("refuses a payload missing a required axis", () => {
    const serialized = serializeSessionsListViewState(buildView());
    Reflect.deleteProperty(serialized, "visibleColumnIds");

    expect(deserializeSessionsListViewState(acrossJson(serialized))).toBeNull();
  });

  it("refuses a view a raw JSON.stringify wrote", () => {
    // The exact payload ISS-8693 is about: a build that stringified the state
    // directly stored every Set as `{}`. Read by shape that is a valid plain
    // object, so it would restore as a view with no columns — the silently
    // wrong answer this boundary exists to refuse.
    const rawStringified = JSON.parse(
      JSON.stringify({
        dateRange: "7d",
        facets: {},
        grouping: {},
        hiddenSummaryCardIds: new Set(["cost"]),
        page: 0,
        scopeUserId: null,
        sortBy: null,
        sortDir: "asc",
        visibleColumnIds: new Set(["status"]),
      })
    );

    expect(rawStringified.visibleColumnIds).toStrictEqual({});
    expect(deserializeSessionsListViewState(rawStringified)).toBeNull();
  });

  it("refuses a scalar axis that arrives carrying a set tag", () => {
    const serialized = serializeSessionsListViewState(buildView());
    serialized.page = { "@@set": [1, 2, 3] };

    expect(deserializeSessionsListViewState(acrossJson(serialized))).toBeNull();
  });

  it("refuses a set axis that arrives carrying a map tag", () => {
    const serialized = serializeSessionsListViewState(buildView());
    serialized.visibleColumnIds = { "@@map": [["status", "on"]] };

    expect(deserializeSessionsListViewState(acrossJson(serialized))).toBeNull();
  });

  it.each([
    ["a payload that is not an array", { "@@map": "not-an-array" }],
    ["entries that are not pairs", { "@@map": [["only-a-key"]] }],
  ])(
    "drops an UNDECLARED axis carrying %s, keeping the rest of the view",
    (_label, malformed) => {
      // DELIBERATE BEHAVIOUR CHANGE (ISS-9447 M2): both cases asserted
      // `toBeNull()`. The axis is one this build does not declare, so refusing
      // discarded every axis it COULD have restored — the reader's whole saved
      // layout — over a field it does not even know exists. The two cases just
      // above keep asserting `null` for a DECLARED axis, which is the half that
      // still holds: an axis the caller asked for cannot be half-restored.
      const serialized = serializeSessionsListViewState(buildView());
      serialized[FORWARD_MAP_AXIS] = malformed;

      const restored = deserializeSessionsListViewState(acrossJson(serialized));

      expect(restored).not.toBeNull();
      // Not vacuous: the declared axes really came back, rather than the
      // restore merely surviving.
      expect(restored?.facets).toStrictEqual(buildView().facets);
      expect(restored?.visibleColumnIds).toStrictEqual(
        buildView().visibleColumnIds
      );
      // The corrupt axis is gone rather than round-tripped back to storage,
      // where it would refuse the view again on the build that names it.
      expect(Object.hasOwn(restored as object, FORWARD_MAP_AXIS)).toBe(false);
    }
  );

  it("does not let a stored __proto__ key reach the restored state", () => {
    const restored = deserializeSessionsListViewState(
      JSON.parse(`{${MINIMAL_STORED_AXES},"__proto__":{"polluted":true}}`)
    );

    expect(restored).not.toBeNull();
    expect(Reflect.getPrototypeOf(restored ?? {})).toBe(Object.prototype);
    expect(Reflect.get(restored ?? {}, "polluted")).toBeUndefined();
  });

  // Every case below is a payload whose axes are all PRESENT and correctly
  // tagged, so tag-and-key-presence checking alone hands it back as a
  // `SessionsListViewState` (codex/whitlockk, #6363).
  it.each([
    ["facets is null", "facets", null],
    ["facets is the empty object a raw stringify wrote", "facets", {}],
    ["a facet is not an array of strings", "facets", { statuses: [7] }],
    ["page is not a number", "page", "four"],
    ["page is negative", "page", -1],
    ["page is fractional", "page", 1.5],
    ["sortDir is outside its closed domain", "sortDir", "sideways"],
    ["dateRange is outside its closed domain", "dateRange", "yesterday"],
    ["scopeUserId is not a string or null", "scopeUserId", 7],
    ["grouping is missing a level", "grouping", { primary: GROUPING.primary }],
    [
      "a grouping order is outside its closed domain",
      "grouping",
      {
        ...GROUPING,
        secondary: { ...GROUPING.secondary, order: "sideways" },
      },
    ],
    ["sorts is not an array", "sorts", { direction: "asc", fieldId: "name" }],
    ["a sort rule has no direction", "sorts", [{ fieldId: "name" }]],
  ])("refuses a stored view where %s", (_name, axis, value) => {
    const serialized = serializeSessionsListViewState(buildView());
    serialized[axis] = value;

    expect(deserializeSessionsListViewState(acrossJson(serialized))).toBeNull();
  });

  // The custom-field axis is a DECLARED map, so its entries are validated
  // rather than merely untagged: `filterSessionsByCustomFields` reads
  // `selectedValues.includes(...)` off the `options` branch, so a stored filter
  // whose shape does not match its own `kind` would throw in a render.
  it.each([
    ["a filter kind is outside its closed domain", [["c:t", { kind: "tier" }]]],
    [
      "an options filter carries no selected values",
      [["c:t", { kind: "options" }]],
    ],
    [
      "an options filter's selection is not strings",
      [["c:t", { kind: "options", selectedValues: [7] }]],
    ],
    ["a range bound is not a number", [["c:b", { kind: "range", min: "ten" }]]],
    ["a filter key is not a string", [[7, { kind: "range", min: 1 }]]],
  ])(
    "refuses a stored custom-field filter map where %s",
    (_name, entries: unknown) => {
      const serialized = serializeSessionsListViewState(buildView());
      serialized.customFieldFilters = { "@@map": entries };

      expect(
        deserializeSessionsListViewState(acrossJson(serialized))
      ).toBeNull();
    }
  );

  it("refuses a tagged set whose entries are not strings", () => {
    const serialized = serializeSessionsListViewState(buildView());
    serialized.visibleColumnIds = { "@@set": [1, 2] };

    expect(deserializeSessionsListViewState(acrossJson(serialized))).toBeNull();
  });

  it("refuses the corrupt facets the list would throw on", () => {
    const serialized = serializeSessionsListViewState(buildView());
    serialized.facets = null;
    const restored = deserializeSessionsListViewState(acrossJson(serialized));

    expect(restored).toBeNull();
    // Why `null` is the only safe answer: the production consumer reads
    // `facets.statuses.length`, so handing this payload back as a view state
    // moves the failure from this boundary into a render.
    const stored = acrossJson(serialized) as { facets: SessionFacetFilters };
    expect(() =>
      resolveSessionsFiltersActive({
        customWindowActive: false,
        dateRange: DEFAULT_DATE_RANGE,
        facets: stored.facets,
        isServerDriven: false,
        scopeUserId: null,
        search: "",
      })
    ).toThrow();
  });

  it("carries an unknown key inside a declared object axis across", () => {
    // Same cadence-skew reason an unknown AXIS is carried across: a facet only
    // the newer build names must survive the older build re-saving the view.
    const serialized = serializeSessionsListViewState(buildView());
    serialized.facets = { ...buildView().facets, envIds: ["staging"] };
    const view = buildView();
    serialized.grouping = {
      primary: { ...view.grouping.primary, collapsed: true },
      secondary: view.grouping.secondary,
      tertiary: { field: "extra" },
    };

    const restored = deserializeSessionsListViewState(acrossJson(serialized));

    expect(Reflect.get(restored?.facets ?? {}, "envIds")).toStrictEqual([
      "staging",
    ]);
    expect(Reflect.get(restored?.grouping?.primary ?? {}, "collapsed")).toBe(
      true
    );
    expect(Reflect.get(restored?.grouping ?? {}, "tertiary")).toStrictEqual({
      field: "extra",
    });
  });
});

/** A valid stored payload's required axes, as raw JSON text. */
const MINIMAL_STORED_AXES = [
  `"visibleColumnIds":{"@@set":[]}`,
  `"sortBy":null`,
  `"sortDir":"asc"`,
  `"grouping":{"primary":{"fieldId":null,"order":"custom","showEmptyGroups":false},"secondary":{"fieldId":null,"order":"asc","showEmptyGroups":false}}`,
  `"facets":{"autonomyTiers":[],"changePresence":[],"costBuckets":[],"harnesses":[],"models":[],"prAssociation":[],"projectIds":[],"repositories":[],"statuses":[],"userIds":[]}`,
  `"dateRange":"7d"`,
  `"page":0`,
  `"scopeUserId":null`,
].join(",");
