import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  EMPTY_TABLE_GROUPING,
  TableSavedViewScope,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionTableRowFixture,
  SESSION_FIXTURE_NOW_MS,
} from "../session-list-fixtures";
import type {
  SessionsSavedView,
  SessionsSavedViewsController,
} from "../sessions-list-saved-views";
import {
  resolveSessionsFiltersActive,
  resolveSessionsRows,
} from "../sessions-list-surface-model";
import {
  SESSIONS_HISTORY_LIST_TEST_ID,
  SessionsListSurfaceV2,
} from "../sessions-list-surface-v2";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  resolveSessionsSearchTerm,
  type SessionsListViewState,
} from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-8966 — the SEARCH axis of `SessionsListViewState`.
 *
 * `SessionsListViewState` had no search axis at all, so a host that owned a
 * `?search=` term had nowhere to put it. Nothing chipped it,
 * `resolveSessionsFiltersActive` could not count it, and "Clear all" could not
 * strip it — and the count is the one that shipped a lie: with the term
 * uncounted, `filtersActive` stayed false, `renderSessionsListBody` handed
 * `hasActiveFilters: false` to the empty state, and a search that matched
 * nothing rendered the ONBOARDING "no sessions yet" over an account with plenty
 * of sessions.
 *
 * The server-driven case is where that was fatal and it is the headline below:
 * there `listNarrowed` IS `filtersActive`, so nothing else could catch the
 * narrowing. The client case has a second signal (`rows` non-empty, `sorted`
 * empty) that keeps the NARRATIVE honest on its own, so what the count decides
 * there is whether the reader is offered a way out at all.
 */

/** The copy `SessionsEmptyState` renders for `ListEmptyReason.Filtered`. */
const FILTERED_EMPTY_COPY =
  "No sessions match the current filters. Try clearing or widening a filter.";

/** The copy it renders for `ListEmptyReason.Empty` — the one this must not be. */
const GENUINELY_EMPTY_TITLE = "No sessions yet";

const SEARCH_TERM = "deploy";

/** A term no fixture row's name, id or model contains. */
const UNMATCHED_TERM = "zzz-no-such-session";

/** `FilterPopover`'s trigger, which appends `: <count>` once a facet is active. */
const FILTER_BUTTON_LABEL = "Filter";

/** The saved-views menu trigger. */
const VIEWS_TRIGGER = "Views";

/**
 * Every searchable field carries a value NO other field on NO other row
 * contains, so a case below can only pass because the predicate read the field
 * it names. `harness` is the one field the fixture factory already defaults, so
 * each row states its own rather than inheriting a shared one.
 */
const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({
    branch: "fix/auth-guard",
    harness: "claude",
    id: "ses-1",
    model: "gpt-5.5",
    name: "agent/refactor-auth-guard",
    repo: "closedloop-ai/closedloop-ai",
  }),
  createSessionTableRowFixture({
    branch: "feat/pipeline",
    harness: "codex",
    id: "ses-2",
    model: "claude-opus-5",
    name: "agent/deploy-pipeline",
    repo: "closedloop-ai/closedloop-ai",
  }),
  createSessionTableRowFixture({
    branch: "chore/rename",
    harness: "claude",
    id: "ses-3",
    model: "gpt-5.5",
    name: "agent/rename-columns",
    repo: "closedloop-ai/design-system",
  }),
];

const BASE_VIEW: SessionsListViewState = {
  sortBy: null,
  sortDir: "asc",
  grouping: EMPTY_TABLE_GROUPING,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  dateRange: DEFAULT_DATE_RANGE,
  visibleColumnIds: new Set(["status"]),
  page: 0,
  scopeUserId: null,
  search: "",
};

/**
 * The same state with NO `search` key — a view written before the axis existed.
 * Built by deletion so it cannot drift from {@link BASE_VIEW}.
 */
const BASE_VIEW_WITHOUT_SEARCH: SessionsListViewState = (() => {
  const withoutSearch = { ...BASE_VIEW };
  Reflect.deleteProperty(withoutSearch, "search");
  return withoutSearch;
})();

/**
 * The client resolver's arguments with nothing else narrowing, so each case
 * below moves exactly one axis.
 */
function clientRowIds(
  rows: readonly SessionTableRow[],
  search: string
): string[] {
  return resolveSessionsRows({
    customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
    dateRange: "all",
    facets: DEFAULT_SESSION_FACET_FILTERS,
    isServerDriven: false,
    rows,
    scopeUserId: null,
    search,
    sorts: [],
  }).sorted.map((row) => row.id);
}

let restoreContainerWidth: (() => void) | null = null;

/**
 * The fixture rows carry a FIXED past start instant, and the client arm applies
 * the default date window, so against the wall clock every mount below would
 * render an empty table for a reason this file is not about. Only `Date` is
 * faked, so React's scheduler and the surface's own interval keep real timers.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SESSION_FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 search axis", () => {
  /**
   * THE case. A server-driven host — which is how both real Sessions shells
   * mount this surface — carrying a search term whose read came back with no
   * rows. The account has sessions; this query matched none of them.
   *
   * Both branches in one case on purpose. A negative alone would also pass
   * against a surface that had stopped rendering the onboarding state at all,
   * and the positive alone would pass against one that always claims to be
   * filtered. The ONLY difference between the two mounts is the search term.
   */
  it("renders the filtered empty for a search that matched nothing, and the onboarding empty for an account that has none", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { unmount } = render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange: vi.fn(),
          totalRows: 0,
          value: { ...BASE_VIEW, search: UNMATCHED_TERM },
        }}
        rows={[]}
        usage={undefined}
      />
    );

    expect(screen.getByText(FILTERED_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText(GENUINELY_EMPTY_TITLE)).toBeNull();
    // The way back, which only exists because the term is COUNTED: the empty
    // state is handed `onClearFilters` solely when `filtersActive` is true.
    // Scoped to the ROWS region — the toolbar's filter popover carries a
    // clear-X with the same accessible name, and it is not the affordance
    // under test.
    expect(emptyStateClearFilters()).toBeInTheDocument();
    // The toolbar's Filter button counts the term too. This is the assertion
    // that pins `foldSessionSearchIntoFacetGroups` reaching the POPOVER's view
    // model and not only the chip row's: `FilterPopover` derives its count from
    // `facetGroups.filter(isFilterMenuGroupActive)`, so a fold applied to one
    // and not the other leaves a bare "Filter" — no count, no clear-X — beside
    // a chip reading "Search: …" and an empty state saying the filters excluded
    // everything. That is this ticket's own defect, one control over, and the
    // chip assertions further down cannot see it.
    expect(screen.getByLabelText(FILTER_BUTTON_LABEL)).toHaveTextContent(
      `${FILTER_BUTTON_LABEL}: 1`
    );

    // A fresh mount rather than a rerender, so nothing survives from the first.
    unmount();
    render(
      <SessionsListSurfaceV2
        controlledView={{ onChange: vi.fn(), totalRows: 0, value: BASE_VIEW }}
        rows={[]}
        usage={undefined}
      />
    );

    expect(screen.getByText(GENUINELY_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(FILTERED_EMPTY_COPY)).toBeNull();
    // …and the Filter button drops back to its bare, uncounted state, so the
    // count above is a claim about the TERM and not about zero rows.
    expect(screen.getByLabelText(FILTER_BUTTON_LABEL)).toHaveTextContent(
      FILTER_BUTTON_LABEL
    );
    expect(screen.getByLabelText(FILTER_BUTTON_LABEL)).not.toHaveTextContent(
      `${FILTER_BUTTON_LABEL}: 1`
    );
  });

  /**
   * The same question on a CLIENT-driven mount, where the account's sessions are
   * genuinely in hand: three rows go in, the term matches none of them, and the
   * list must say it is filtered rather than empty AND offer the way out.
   *
   * The "Clear filters" assertion is the load-bearing half here. The narrative
   * has a second signal on this arm (`rows` non-empty while `sorted` is empty),
   * so a resolver that stopped counting the term would still print the filtered
   * copy — and silently withdraw the only control that undoes the narrowing.
   */
  it("says a searched-away client list is filtered and offers the way out", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(
      <SessionsListSurfaceV2
        initialSearch={UNMATCHED_TERM}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(screen.getByText(FILTERED_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText(GENUINELY_EMPTY_TITLE)).toBeNull();
    expect(emptyStateClearFilters()).toBeInTheDocument();
  });

  /**
   * AC: "Clear all" strips the term, on the ONE control a searched-away list
   * actually offers.
   *
   * This is the empty state's own "Clear filters", which calls `clearAllFilters`
   * DIRECTLY rather than through `ActiveFiltersBar` — so it is the path that
   * proves the term is cleared by that handler and not merely by the chip
   * `onToggle` the bar happens to fire afterwards. With the term left applied
   * there, the single button a reader is offered on a list they cannot see past
   * would report a state that still carries the search, the host would rewrite
   * the same `?search=` URL, and the control would do nothing at all — v1 strips
   * the param in its own `handleClearFilters` for exactly this reason.
   */
  it("strips the search term through the empty state's own Clear filters", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const searched: SessionsListViewState = {
      ...BASE_VIEW,
      search: UNMATCHED_TERM,
    };
    render(
      <SessionsListSurfaceV2
        controlledView={{ onChange, totalRows: 0, value: searched }}
        rows={[]}
        usage={undefined}
      />
    );

    fireEvent.click(emptyStateClearFilters());

    expect(onChange).toHaveBeenLastCalledWith({
      ...searched,
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      dateRange: DEFAULT_DATE_RANGE,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      scopeUserId: null,
      search: "",
    });
  });

  /**
   * A saved view APPLIES as a patch, so an axis the stored value has no key for
   * leaves the live one standing.
   *
   * That is the ISS-8216 defect this file's `customFieldFilters` sibling already
   * carries a comment for, on the axis this ticket adds: applying a view stored
   * before the axis existed left the reader's term in force, so the list stayed
   * narrowed by a search the applied view does not represent and the chip row
   * went on naming it. The two compile-time axis guards
   * (`SESSIONS_VIEW_STATE_AXES`, `SESSIONS_VIEW_STATE_AXIS_OWNERS`) do not reach
   * `savedViewPatch`, so nothing but this case can catch it.
   *
   * Both directions: the pre-axis view clears the live term, and a view that
   * genuinely stores one applies it — so this cannot pass against a patch that
   * simply hardcodes `""`.
   */
  it("clears a live search term when a view stored before the axis is applied", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const reported: string[] = [];

    render(
      <SavedViewHost
        onView={(view) => reported.push(view.search ?? "<absent>")}
        seed={{ ...BASE_VIEW, search: SEARCH_TERM }}
        views={[PRE_AXIS_VIEW, SEARCHED_VIEW]}
      />
    );

    applySavedView(PRE_AXIS_VIEW.name);
    expect(reported.at(-1)).toBe("");

    applySavedView(SEARCHED_VIEW.name);
    expect(reported.at(-1)).toBe(UNMATCHED_TERM);
  });

  /**
   * The unit behind both, pinned against LITERALS rather than against another
   * reading of the same helper — a fixture that derived "is a filter active"
   * from `resolveSessionsFiltersActive` itself would stay green with the search
   * term deleted from it.
   *
   * Both arms, because the term narrows in both: server-driven through the
   * host's own query, client-side through `resolveSessionsRows`.
   */
  it("counts a search term as an active filter in both arms and an empty one in neither", () => {
    const unsearched = {
      dateRange: DEFAULT_DATE_RANGE,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      scopeUserId: null,
      search: "",
    };

    expect(
      resolveSessionsFiltersActive({
        customWindowActive: false,
        ...unsearched,
        isServerDriven: true,
        search: SEARCH_TERM,
      })
    ).toBe(true);
    expect(
      resolveSessionsFiltersActive({
        customWindowActive: false,
        ...unsearched,
        isServerDriven: false,
        search: SEARCH_TERM,
      })
    ).toBe(true);
    expect(
      resolveSessionsFiltersActive({
        customWindowActive: false,
        ...unsearched,
        isServerDriven: true,
      })
    ).toBe(false);
    expect(
      resolveSessionsFiltersActive({
        customWindowActive: false,
        ...unsearched,
        isServerDriven: false,
      })
    ).toBe(false);
  });

  /**
   * Absent, empty and whitespace-only are three spellings of "nothing searched",
   * and every reader has to agree on that — a row filter treating `"  "` as a
   * term while the count treated it as nothing is how a list empties itself and
   * then reports the account has no sessions.
   */
  it("resolves absent, empty and whitespace-only terms to the same nothing", () => {
    expect(resolveSessionsSearchTerm(undefined)).toBe("");
    expect(resolveSessionsSearchTerm("")).toBe("");
    expect(resolveSessionsSearchTerm("   ")).toBe("");
    expect(resolveSessionsSearchTerm("  deploy  ")).toBe(SEARCH_TERM);
  });

  /**
   * The client-side narrowing itself, in BOTH directions in every case: a
   * fixture whose rows all matched would pass against a resolver that filters
   * nothing, which is precisely the defect a counted-but-unapplied term would
   * be.
   */
  it("keeps only the rows whose name, id or model contains the term", () => {
    expect(clientRowIds(ROWS, SEARCH_TERM)).toEqual(["ses-2"]);
    expect(clientRowIds(ROWS, "ses-3")).toEqual(["ses-3"]);
    expect(clientRowIds(ROWS, "claude-opus")).toEqual(["ses-2"]);
    // Case-insensitive, matching the producer's own `LIKE` predicate.
    expect(clientRowIds(ROWS, "DEPLOY")).toEqual(["ses-2"]);
    expect(clientRowIds(ROWS, UNMATCHED_TERM)).toEqual([]);
    // The unsearched control: every row survives, so the cases above narrowed
    // because of the term rather than because the resolver drops rows.
    expect(clientRowIds(ROWS, "")).toEqual(["ses-1", "ses-2", "ses-3"]);
  });

  /**
   * The three fields the desktop LIST source searches that a `SessionTableRow`
   * also carries (whitlockk, #6528). Each term below appears in exactly one field of
   * exactly one row, so a predicate that stopped reading that field would return
   * `[]` — the drop this case exists to catch — rather than a wider list.
   */
  it("keeps the rows whose harness, branch or repository contains the term", () => {
    expect(clientRowIds(ROWS, "codex")).toEqual(["ses-2"]);
    expect(clientRowIds(ROWS, "chore/rename")).toEqual(["ses-3"]);
    expect(clientRowIds(ROWS, "design-system")).toEqual(["ses-3"]);
    // Case-folded on these fields too, not only on the three that shipped.
    expect(clientRowIds(ROWS, "CODEX")).toEqual(["ses-2"]);
    // A repository BOTH rows carry narrows to both, so the cases above returned
    // one row because one row matched, not because the predicate caps its list.
    expect(clientRowIds(ROWS, "closedloop-ai/closedloop-ai")).toEqual([
      "ses-1",
      "ses-2",
    ]);
  });

  /**
   * The fields are joined into one haystack, so the separator has to be real: a
   * bare join would let a term straddling the id/harness seam match a row on a
   * substring no field of it contains.
   */
  it("does not match a term that only spans the seam between two fields", () => {
    // The positive control on the same rows and the same selector: each half of
    // the seam term matches on its own.
    expect(clientRowIds(ROWS, "ses-2")).toEqual(["ses-2"]);
    expect(clientRowIds(ROWS, "codex")).toEqual(["ses-2"]);
    expect(clientRowIds(ROWS, "ses-2codex")).toEqual([]);
  });

  /**
   * A server page is NOT re-filtered. Its rows are the answer the host's own
   * query already gave to this same term, and re-applying a client predicate to
   * them would drop rows the server matched — the server searches a field
   * (`cwd`) this row model does not even carry.
   */
  it("leaves a server-driven page untouched however narrow the term", () => {
    const result = resolveSessionsRows({
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      dateRange: "all",
      facets: DEFAULT_SESSION_FACET_FILTERS,
      isServerDriven: true,
      rows: ROWS,
      scopeUserId: null,
      search: UNMATCHED_TERM,
      sorts: [],
    });

    expect(result.sorted.map((row) => row.id)).toEqual([
      "ses-1",
      "ses-2",
      "ses-3",
    ]);
  });

  /**
   * The chip, and the two writes that remove it.
   *
   * ONE mount for both, because a controlled surface never self-applies: the
   * rendered state is identical before each click, and a mount here carries a
   * toolbar, four menus and the summary strip.
   *
   * "Clear all" is `clearAllFilters()` followed by one `onToggle` per selected
   * value, synchronously and with no render between, so it is asserted on the
   * LAST reported state — that is the one settled `SessionsListViewState` a host
   * stores and writes its URL from.
   */
  it("chips an active search and reports its removal as one settled state", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const searched: SessionsListViewState = {
      ...BASE_VIEW,
      facets: withFacets({ userIds: ["user-pascoe"] }),
      page: 2,
      search: SEARCH_TERM,
    };
    render(
      <SessionsListSurfaceV2
        // Enough rows for page 2 to exist: an out-of-range page makes the
        // surface report a clamp of its own on mount, which would be counted
        // as one of this click's writes.
        controlledView={{ onChange, totalRows: 100, value: searched }}
        rows={[ROWS[1] as SessionTableRow]}
        usage={undefined}
      />
    );

    // The chip names the term the way every other facet chip names its
    // selection, and its icon-only clear carries the accessible name.
    fireEvent.click(
      screen.getByLabelText(`Remove Search: ${SEARCH_TERM} filter`)
    );

    // ONE call carrying the cleared term AND the page reset. Two sequential
    // writes would also produce a call matching one half, so the count is what
    // distinguishes them.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...searched,
      page: 0,
      search: "",
    });

    onChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    expect(onChange).toHaveBeenLastCalledWith({
      ...searched,
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      search: "",
    });
  });
});

/**
 * The empty state's own "Clear filters", scoped to the rows region. The
 * toolbar's filter popover renders a clear-X with the same accessible name.
 */
function emptyStateClearFilters(): HTMLElement {
  return within(screen.getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).getByRole(
    "button",
    { name: "Clear filters" }
  );
}

/** A view saved before the `search` axis existed: no key at all. */
const PRE_AXIS_VIEW: SessionsSavedView = {
  id: "pre-axis",
  name: "Pre-axis view",
  scope: TableSavedViewScope.Personal,
  value: BASE_VIEW_WITHOUT_SEARCH,
};

/** Its sibling, which genuinely stores a term. */
const SEARCHED_VIEW: SessionsSavedView = {
  id: "searched",
  name: "Searched view",
  scope: TableSavedViewScope.Personal,
  value: { ...BASE_VIEW, search: UNMATCHED_TERM },
};

/**
 * A host that actually STORES what the surface reports. Against a `vi.fn()` the
 * surface never moves, so a patch that dropped the axis would look identical to
 * one that cleared it.
 */
function SavedViewHost({
  onView,
  seed,
  views,
}: {
  onView: (view: SessionsListViewState) => void;
  seed: SessionsListViewState;
  views: readonly SessionsSavedView[];
}) {
  const [view, setView] = useState(seed);
  const savedViews: SessionsSavedViewsController = {
    activeViewId: null,
    onSave: () => undefined,
    views,
  };
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: (next) => {
          onView(next);
          setView(next);
        },
        value: view,
      }}
      rows={ROWS}
      savedViews={savedViews}
      usage={undefined}
    />
  );
}

/** Radix opens on `pointerdown`, not `click`. */
function applySavedView(viewName: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: VIEWS_TRIGGER }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: viewName }));
}

/** One facet selected, every other facet left empty. */
function withFacets(
  selection: Partial<SessionFacetFilters>
): SessionFacetFilters {
  return { ...DEFAULT_SESSION_FACET_FILTERS, ...selection };
}
