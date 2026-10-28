import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { SessionsBulkFavoriteReport } from "@repo/app/agents/components/sessions/sessions-list-interactions";
import { agentSessionKeys } from "@repo/app/agents/hooks/agent-session-keys";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { SessionsHostViewState } from "@repo/app/agents/lib/sessions-list-view-adapter";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import {
  EMPTY_TABLE_GROUPING,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";

/**
 * ISS-8335 — the host must round-trip EVERY axis of the surface's view state,
 * including the ones the page's saved view has no column for.
 *
 * The defect this file pins is not a missing component. Every control below
 * already rendered on the live surface and already reported its change; the
 * host's `onChange` then handed the whole `SessionsListViewState` to a
 * `toSessionsHostViewState` whose parameter type listed only eight of its
 * eleven axes. A wider object is a legal argument for a narrower parameter and
 * excess-property checking does not run on a variable, so `layout` and `sorts`
 * were dropped in silence and `grouping` was flattened to its primary level —
 * and the next render re-derived the defaults. The reader saw a Board segment
 * that snapped back to List, a sub-group that would not add, and a second sort
 * rule that vanished.
 *
 * These cases therefore assert the CONTROLLER the host hands down, because that
 * is the seam that was lossy: what the host reports in, it must render back out.
 * The surface is stubbed so each axis is asserted on its own rather than through
 * whichever menu happens to expose it, and every assertion runs in the test body
 * after the production render.
 */

type CapturedController = {
  value: {
    customFieldFilters?: ReadonlyMap<string, unknown>;
    grouping: typeof EMPTY_TABLE_GROUPING;
    search?: string;
    sorts?: readonly { fieldId: string; direction: string }[];
  };
  onChange: (next: never) => void;
};

const captured: {
  controller: CapturedController | null;
  /**
   * ISS-8335: what the PAGE holds after the round-trip.
   *
   * Asserted alongside the controller because the two answer different
   * questions, and only one of them was ever the defect. The controller echo was
   * TRUE while the second sort rule lived in the host's own component state — it
   * rendered back out and still reached no query. What proves the rule is real
   * is that it survives into `SessionsHostViewState`, which is the value the
   * page persists and puts on the wire.
   */
  hostView: SessionsHostViewState | null;
  /** The surface's own Reset action, which is the host's `handleResetView`. */
  onResetView: (() => void) | null;
  customFields: unknown;
  favorites: {
    favoriteIds: ReadonlySet<string>;
    onBulkChange?: (
      rows: readonly { id: string }[],
      favorited: boolean
    ) => Promise<SessionsBulkFavoriteReport>;
    onChange: (row: { id: string }, favorited: boolean) => void;
  } | null;
} = {
  controller: null,
  customFields: null,
  favorites: null,
  hostView: null,
  onResetView: null,
};

const SESSIONS_LIST_KEY = agentSessionKeys.list("cloud", {});

/** A resolved lineage view keyed on the artifact it was fetched for. */
function resolvedLinkKey(artifactId: string): readonly unknown[] {
  return artifactLinkKeys.list({ artifactId, resolved: true });
}

let queryClient = new QueryClient();

const toggleFavoriteMutate = vi.fn();
const toggleFavoriteMutateAsync = vi.fn(
  (_input: { artifactId: string; isFavorite: boolean }): Promise<void> =>
    Promise.resolve()
);

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useFeatureFlagEnabled: () => false,
  })
);

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({
    data: [{ id: "ses-1" }],
    isError: false,
    isPending: false,
  }),
  useToggleFavoriteArtifact: () => ({
    mutate: toggleFavoriteMutate,
    mutateAsync: toggleFavoriteMutateAsync,
  }),
}));

vi.mock("@repo/app/agents/hooks/use-session-owner-name-resolver", () => ({
  useSessionOwnerNameResolver: () => undefined,
}));

vi.mock("@repo/app/agents/hooks/use-session-project-name-resolver", () => ({
  useSessionProjectNameResolver: () => undefined,
}));

vi.mock("@repo/app/agents/hooks/use-sessions-custom-fields-controller", () => ({
  useSessionsCustomFieldsController: () => ({
    fields: [],
    valuesBySessionId: new Map(),
  }),
}));

// The surface itself is exercised by its own suite. Here it is a probe: it
// records the controller and the seams the host hands down so each axis can be
// asserted from the test body.
vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  () => ({
    SessionsListSurfaceV2: (props: {
      controlledView: CapturedController;
      customFields?: unknown;
      favorites: typeof captured.favorites;
      onResetView?: () => void;
    }) => {
      captured.controller = props.controlledView;
      captured.customFields = props.customFields;
      captured.favorites = props.favorites;
      captured.onResetView = props.onResetView ?? null;
      return null;
    },
  })
);

const HOST_VIEW: SessionsHostViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  groupBy: SessionGroupBy.None,
  page: 0,
  scopeUserId: null,
  search: "",
  secondarySorts: [],
  sortDir: "asc",
  sortKey: null,
  visibleColumns: new Set(["status"]),
};

const ITEMS: readonly AgentSessionListItem[] = [];

/**
 * The page's half of the contract: it stores what the host reports and feeds it
 * straight back. Anything the round-trip drops is therefore gone by the next
 * render, exactly as it is in production.
 */
function HostUnderTest({ seed = HOST_VIEW }: { seed?: SessionsHostViewState }) {
  const [hostView, setHostView] = useState(seed);
  captured.hostView = hostView;
  return (
    <QueryClientProvider client={queryClient}>
      <SessionsListV2Host
        getSessionHref={(item) => `/org/sessions/${item.id}`}
        hostView={hostView}
        isListPending={false}
        items={ITEMS}
        listReadState={SessionsListReadState.Settled}
        onHostViewChange={setHostView}
        onResetView={() => setHostView(seed)}
        pageSize={25}
        summaryIsLoading={false}
        total={0}
        usage={undefined}
      />
    </QueryClientProvider>
  );
}

function reportViewChange(patch: Record<string, unknown>) {
  const controller = captured.controller;
  if (!controller) {
    throw new Error("surface never received a controlled view");
  }
  act(() => {
    controller.onChange({ ...controller.value, ...patch } as never);
  });
}

beforeEach(() => {
  queryClient = new QueryClient();
  // Seeded so `isInvalidated` reads a real cache entry: `invalidateQueries`
  // against a key nothing is cached under says nothing at all.
  queryClient.setQueryData(SESSIONS_LIST_KEY, []);
  for (const artifactId of ["ses-1", "ses-2"]) {
    queryClient.setQueryData(resolvedLinkKey(artifactId), [
      { sourceId: artifactId, targetId: "other" },
    ]);
  }
});

afterEach(() => {
  cleanup();
  captured.controller = null;
  captured.customFields = null;
  captured.hostView = null;
  captured.onResetView = null;
  captured.favorites = null;
  toggleFavoriteMutate.mockClear();
  toggleFavoriteMutateAsync.mockClear();
  toggleFavoriteMutateAsync.mockImplementation(() => Promise.resolve());
});

describe("SessionsListV2Host view-state round trip", () => {
  /**
   * ISS-8216: the axis this ticket added, and the same class as `layout` above.
   *
   * A `custom-field:*` id has no slot in the page's closed facet vocabulary, so
   * `toSessionsHostViewState` cannot carry it and `toSessionsListViewState`
   * cannot produce it. Moving the axis off the surface's private `useState`
   * therefore made it the host's to hold — a controlled surface stores nothing —
   * and without that the facet menu ticked a value and un-ticked it on the next
   * render.
   */
  it("keeps a custom-field filter the page's facets cannot store", () => {
    render(<HostUnderTest />);

    reportViewChange({
      customFieldFilters: new Map([
        ["custom-field:stage", { kind: "options", selectedValues: ["Build"] }],
      ]),
    });

    expect([...(captured.controller?.value.customFieldFilters ?? [])]).toEqual([
      ["custom-field:stage", { kind: "options", selectedValues: ["Build"] }],
    ]);
  });

  /**
   * ISS-8966: the SEARCH axis, in the direction a `?search=` URL travels — host
   * → surface. Without it the term had no slot on `SessionsListViewState` at
   * all, so a searched list reached the surface indistinguishable from an
   * unsearched one and its empty state said the account had no sessions.
   */
  it("hands the host's search term down to the surface", () => {
    render(<HostUnderTest seed={{ ...HOST_VIEW, search: "deploy" }} />);

    expect(captured.controller?.value.search).toBe("deploy");
  });

  /**
   * And back: the surface reports ONE settled view state per event, so the
   * cleared term has to survive `toSessionsHostViewState` into the value the
   * host hands its page.
   *
   * WHAT THIS CANNOT SEE, stated so nobody reads more into it: `HostUnderTest`
   * stores the reported state verbatim, so it cannot drop a field, and the real
   * page's change handler is not in the loop. This proves the HOST COMPONENT
   * wires the adapter in both directions — the axis reaches the controller and
   * comes back through `toSessionsHostViewState` — and nothing about whether a
   * page then acts on it. A page that ignores the cleared term stays green here.
   *
   * Seeded WITH a term so the assertion discriminates: from `""` the round-trip
   * would return `""` however lossy it was.
   */
  it("reports a cleared search term back in the host's own vocabulary", () => {
    render(<HostUnderTest seed={{ ...HOST_VIEW, search: "deploy" }} />);

    expect(captured.hostView?.search).toBe("deploy");

    reportViewChange({ search: "" });

    expect(captured.hostView?.search).toBe("");
  });

  it("keeps a sub-group level the page's single groupBy cannot store", () => {
    render(<HostUnderTest />);

    reportViewChange({
      grouping: {
        primary: {
          fieldId: "status",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: {
          fieldId: "harness",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
      },
    });

    expect(captured.controller?.value.grouping.primary.fieldId).toBe("status");
    expect(captured.controller?.value.grouping.secondary.fieldId).toBe(
      "harness"
    );
  });

  it("carries a second sort rule into the state the PAGE persists", () => {
    render(<HostUnderTest />);

    reportViewChange({
      sortBy: "status",
      sortDir: "asc",
      sorts: [
        { direction: "asc", fieldId: "status" },
        { direction: "desc", fieldId: "cost" },
      ],
    });

    // The assertion that matters (codex review PRRT_kwDOQ4gDpM6dLntW). The host
    // used to hold this rule in component state: it rendered back out, so the
    // controller echo below passed, while `toSessionsHostViewState` returned
    // nothing for it and the query ordered by `status` alone. The rule has to
    // reach the HOST view state, because that is what the page persists and
    // sends.
    expect(captured.hostView?.secondarySorts).toEqual([
      { direction: "desc", fieldId: "cost" },
    ]);
    // …and the toolbar still renders both rules, in order.
    expect(captured.controller?.value.sorts).toEqual([
      { direction: "asc", fieldId: "status" },
      { direction: "desc", fieldId: "cost" },
    ]);
  });

  /**
   * The page's own vocabulary still wins when it moves the primary dimension —
   * a saved view restoring or a Reset must not leave a stale sub-level banding
   * the table. This is the other half of the reconciliation and would go red if
   * the host simply preferred its local copy unconditionally.
   */
  it("drops a stale sub-group when the page changes the primary dimension", () => {
    render(<HostUnderTest />);
    reportViewChange({
      grouping: {
        primary: {
          fieldId: "status",
          order: TableGroupOrder.Custom,
          showEmptyGroups: false,
        },
        secondary: {
          fieldId: "harness",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
      },
    });

    reportViewChange({ grouping: EMPTY_TABLE_GROUPING });

    expect(captured.controller?.value.grouping.primary.fieldId).toBeNull();
    expect(captured.controller?.value.grouping.secondary.fieldId).toBeNull();
  });

  /**
   * The half the reconciler CANNOT cover, and the only shape that fails if
   * `handleResetView`'s `setLocalView(DEFAULT_SESSIONS_HOST_LOCAL_VIEW)` is
   * deleted (cr-33230).
   *
   * The primary dimension never moves here — the page holds `groupBy: None`
   * before and after — so `reconcileSessionsGrouping` agrees with the page and
   * hands back the HOST's copy, sub-level and all. Any case that moves the
   * primary instead is reconciled to the page's value either way and so passes
   * with the local clear removed.
   */
  it("clears a host-local sub-group on a reset the page's own dimension never moves", () => {
    render(<HostUnderTest />);
    reportViewChange({
      grouping: {
        primary: EMPTY_TABLE_GROUPING.primary,
        secondary: {
          fieldId: "harness",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
      },
    });
    expect(captured.controller?.value.grouping.secondary.fieldId).toBe(
      "harness"
    );

    act(() => captured.onResetView?.());

    expect(captured.controller?.value.grouping.secondary.fieldId).toBeNull();
    // The page's half never moved, so a green here cannot be the reconciler
    // discarding a mismatched primary.
    expect(captured.hostView?.groupBy).toBe(SessionGroupBy.None);
  });
});

describe("SessionsListV2Host favorites seam", () => {
  it("hands the surface the batched artifact favorites", () => {
    render(<HostUnderTest />);

    expect(captured.favorites?.favoriteIds.has("ses-1")).toBe(true);
  });

  it("toggles a row against its CURRENT favorite state", () => {
    render(<HostUnderTest />);

    captured.favorites?.onChange({ id: "ses-2" }, true);

    expect(toggleFavoriteMutate).toHaveBeenCalledWith({
      artifactId: "ses-2",
      isFavorite: false,
    });
  });

  /**
   * whitlockk review cid 3880964961 — one failed row must not erase the rest.
   *
   * `Promise.all` rejected on the first rejection, so the whole batch surfaced
   * as a failure while the mutations that had already resolved stayed applied
   * on the server. `allSettled` plus a positional outcome is what lets the bulk
   * bar tell the reader which half is which.
   */
  it("reports which rows landed when one of a bulk change fails", async () => {
    render(<HostUnderTest />);
    toggleFavoriteMutateAsync.mockImplementation(
      ({ artifactId }: { artifactId: string }) =>
        artifactId === "ses-2"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve()
    );

    const outcome = await captured.favorites?.onBulkChange?.(
      [{ id: "ses-1" }, { id: "ses-2" }, { id: "ses-3" }],
      true
    );

    // Resolved, not thrown — and it names the rows rather than counting them.
    expect(outcome).toEqual({
      failedIds: ["ses-2"],
      succeededIds: ["ses-1", "ses-3"],
    });
    // Every row was still attempted: the old shape short-circuited nothing, but
    // a `for await` "fix" would have, so this pins that it does not.
    expect(toggleFavoriteMutateAsync).toHaveBeenCalledTimes(3);
    // ISS-9578: the rows that LANDED refresh every other view of themselves.
    // The per-artifact mutation refreshes the favorites list and nothing else,
    // so without this the Sessions list beside the star kept its stale row.
    expect(isInvalidated(SESSIONS_LIST_KEY)).toBe(true);
    // The half of the set the receipt decides. This is the one bulk path where
    // a REFUSED row is reachable — the v1 documents routes report the
    // requested set — so it is where "a refused id's lineage is left alone"
    // can be pinned at all.
    expect(isInvalidated(resolvedLinkKey("ses-1"))).toBe(true);
    expect(isInvalidated(resolvedLinkKey("ses-2"))).toBe(false);
  });

  /**
   * ISS-9578: the Sessions bulk bar was the third of three surfaces each
   * maintaining its own invalidation list. It now drives the shared one from
   * the same receipt — which means a bulk change that landed NOTHING refreshes
   * nothing, rather than reporting a change the server did not make.
   */
  it("refreshes nothing when no row in a bulk favorite change landed", async () => {
    render(<HostUnderTest />);
    toggleFavoriteMutateAsync.mockImplementation(() =>
      Promise.reject(new Error("offline"))
    );

    const outcome = await captured.favorites?.onBulkChange?.(
      [{ id: "ses-1" }, { id: "ses-2" }],
      true
    );

    expect(outcome).toEqual({
      failedIds: ["ses-1", "ses-2"],
      succeededIds: [],
    });
    expect(isInvalidated(SESSIONS_LIST_KEY)).toBe(false);
  });
});

function isInvalidated(queryKey: readonly unknown[]): boolean {
  return queryClient.getQueryState(queryKey)?.isInvalidated === true;
}

describe("SessionsListV2Host custom-fields seam", () => {
  it("hands the Sessions custom-fields controller to the surface", () => {
    render(<HostUnderTest />);

    expect(captured.customFields).toMatchObject({ fields: [] });
    expect(
      (captured.customFields as { valuesBySessionId: unknown })
        .valuesBySessionId
    ).toBeInstanceOf(Map);
  });
});
