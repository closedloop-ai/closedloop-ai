"use client";

import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { parseSearchQuery } from "@repo/api/src/types/search-query";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { Input } from "@repo/design-system/components/ui/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { SearchSurfaceReadState } from "../lib/search-surface-model";
import { toggleTypeToken } from "../lib/search-type-tokens";
import { SearchResultCountStrip } from "./search-result-count-strip";
import { SearchSurfaceV2 } from "./search-surface-v2";
import {
  matchesSearchDemoQuery,
  SEARCH_DEMO_HITS,
  SEARCH_DEMO_STATES,
  SearchDemoState,
} from "./search-surface-v2-page-demo-fixtures";
import { SearchSurfaceModeKind } from "./search-surface-v2-props";
import { SearchTypeControl } from "./search-type-control";

/**
 * ISS-10345 — the mock host for the real, prop-driven `SearchSurfaceV2`
 * (`mode: Page`), for a prototype route with no backend.
 *
 * Composes the real content surface with the real `SearchTypeControl`, the real
 * `SearchResultCountStrip`, and the canonical `parseSearchQuery` grammar, so
 * the only prototype-only glue is the query input and the demo-state switcher —
 * everything a reviewer sees of the RESULTS (rows, states, the count sentence,
 * type/status/priority filtering, filter-error messages) is the real production
 * code, not a local re-implementation of it.
 *
 * Lives in `packages/app` rather than the prototype's own file tree because a
 * production-bound prototype route may mount only allowlisted portable
 * surfaces with NO local markup of its own
 * (`scripts/lint/production-bound-prototype-route.ts` fails on the first JSX
 * tag in the prototype's files that isn't bound to an exact-path allowlisted
 * import — composing a query bar, a type control, a count strip AND the
 * results surface directly in the prototype route would each need their own
 * allowlist entry and still fail on the layout markup around them). This demo
 * is the ONE allowlisted surface `apps/prototypes/app/p/search-results/page.tsx`
 * mounts, matching the `SessionsListSurfaceV2Preview` precedent in
 * `../../agents/components/sessions/sessions-list-surface-v2-demo.tsx`.
 */
export function SearchSurfaceV2PageDemo() {
  const [demoState, setDemoState] = useState<SearchDemoState>(
    SearchDemoState.Results
  );
  const [committedQuery, setCommittedQuery] = useState("agent");
  const [draftQuery, setDraftQuery] = useState("agent");

  // The COMMITTED query is what the body reflects, exactly as the real page
  // renders `urlQuery` rather than the in-flight input value.
  const parsed = useMemo(
    () => parseSearchQuery(committedQuery),
    [committedQuery]
  );
  const filterErrorMessage = parsed.errors[0]?.message ?? null;
  const results = useMemo(
    () => SEARCH_DEMO_HITS.filter((hit) => matchesSearchDemoQuery(hit, parsed)),
    [parsed]
  );
  const activeKinds = parsed.filters.type?.kinds ?? [];

  const selectDemoState = (next: SearchDemoState) => {
    const meta = SEARCH_DEMO_STATES.find((entry) => entry.state === next);
    if (!meta) {
      return;
    }
    setDemoState(next);
    setDraftQuery(meta.query);
    setCommittedQuery(meta.query);
  };

  // Re-running the query derives the demo state from it, so the body never
  // contradicts the bar: an empty bar lands the on-ramp, a non-empty bar runs
  // a live result. Mirrors the real page's `commitQuery`.
  const commitQuery = (next: string) => {
    setDraftQuery(next);
    setCommittedQuery(next);
    setDemoState(
      next.trim().length === 0 ? SearchDemoState.Empty : SearchDemoState.Results
    );
  };

  const handleToggleKind = (kind: SearchEntityType) => {
    commitQuery(toggleTypeToken(committedQuery, kind));
  };

  const readState = toReadState(demoState, {
    filterErrorMessage,
    hasQuery: committedQuery.trim().length > 0,
    resultCount: results.length,
  });
  const showCountStrip =
    readState.hasRun && !readState.isUnavailable && !isForcedError(demoState);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="sr-only">Search results</h1>

      <DemoStateSwitcher onSelect={selectDemoState} value={demoState} />

      <div className="flex items-start gap-2">
        {/* The real page commits on Enter and on native form submit through
            `SearchTypeahead` (which owns `useUnifiedSearch` and so cannot be
            mounted here); this bar mirrors that commit contract and adds no
            affordance of its own. */}
        <form
          className="relative flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            commitQuery(draftQuery);
          }}
        >
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search query"
            className="h-11 pr-10 pl-9 text-base md:text-base"
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search, or type a filter: type:agent_session status:DONE"
            type="text"
            value={draftQuery}
          />
          {draftQuery.length > 0 ? (
            <button
              aria-label="Clear query"
              className={`absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground ${CHIP_FOCUS_RING_CLASS}`}
              onClick={() => commitQuery("")}
              type="button"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </form>
        <SearchTypeControl
          activeKinds={activeKinds}
          onToggleKind={handleToggleKind}
        />
      </div>

      {showCountStrip ? (
        <SearchResultCountStrip
          hasMore={SEARCH_DEMO_STATE_HAS_MORE[demoState]}
          isLoading={readState.isLoading}
          loadedCount={results.length}
          onClear={() => commitQuery("")}
          query={committedQuery}
        />
      ) : null}

      <SearchSurfaceV2
        mode={{ kind: SearchSurfaceModeKind.Page, onRunExample: commitQuery }}
        onRetry={() => setDemoState(SearchDemoState.Results)}
        query={committedQuery}
        read={readState}
        results={results}
      />
    </div>
  );
}

// A prototype-only affordance: lets a reviewer jump to any state
// `SearchSurfaceV2` renders. Does NOT exist in the production surface; there,
// the ladder is derived from a real query result, never picked.
function DemoStateSwitcher({
  value,
  onSelect,
}: Readonly<{
  value: SearchDemoState;
  onSelect: (state: SearchDemoState) => void;
}>) {
  return (
    <ToggleGroup
      className="flex-wrap"
      onValueChange={(next) => {
        if (next) {
          onSelect(next as SearchDemoState);
        }
      }}
      size="sm"
      type="single"
      value={value}
      variant="outline"
    >
      {SEARCH_DEMO_STATES.map((entry) => (
        <ToggleGroupItem
          aria-label={`Show ${entry.label} state`}
          key={entry.state}
          value={entry.state}
        >
          {entry.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The two reads a query can never produce on its own. Everything else a
 * reviewer can select — the on-ramp, a live result set, a no-match query, a
 * malformed filter token — is DERIVED from the committed query below, so the
 * switcher cannot put the body in a state the bar contradicts.
 *
 * Exhaustive by construction: an eighth `SearchDemoState` fails `tsc` on this
 * map rather than silently rendering as Ready (#7344 review).
 */
const SEARCH_DEMO_STATE_FORCED_READ: Readonly<
  Record<SearchDemoState, "loading" | "unavailable" | null>
> = {
  [SearchDemoState.Results]: null,
  [SearchDemoState.Empty]: null,
  [SearchDemoState.Loading]: "loading",
  [SearchDemoState.LoadError]: "unavailable",
  [SearchDemoState.FilterError]: null,
  [SearchDemoState.NoResults]: null,
  [SearchDemoState.TooMany]: null,
};

/**
 * Which demo states stand in for a corpus larger than the page has loaded, so
 * the shared count strip says `N+` instead of asserting a total this host
 * cannot compute. Exhaustive for the same reason as the map above.
 */
const SEARCH_DEMO_STATE_HAS_MORE: Readonly<Record<SearchDemoState, boolean>> = {
  [SearchDemoState.Results]: false,
  [SearchDemoState.Empty]: false,
  [SearchDemoState.Loading]: false,
  [SearchDemoState.LoadError]: false,
  [SearchDemoState.FilterError]: false,
  [SearchDemoState.NoResults]: false,
  [SearchDemoState.TooMany]: true,
};

function isForcedError(state: SearchDemoState): boolean {
  return SEARCH_DEMO_STATE_FORCED_READ[state] === "unavailable";
}

function toReadState(
  state: SearchDemoState,
  derived: Readonly<{
    filterErrorMessage: string | null;
    hasQuery: boolean;
    resultCount: number;
  }>
): SearchSurfaceReadState {
  const forced = SEARCH_DEMO_STATE_FORCED_READ[state];

  if (forced === "loading") {
    return {
      hasRun: true,
      isLoading: true,
      isUnavailable: false,
      resultCount: 0,
      unavailableReason: null,
    };
  }

  if (forced === "unavailable") {
    return {
      hasRun: true,
      isLoading: false,
      isUnavailable: true,
      resultCount: 0,
      unavailableReason: null,
    };
  }

  return {
    hasRun: derived.hasQuery,
    isLoading: false,
    // A malformed inline filter is the query failing, so the surface names it
    // and offers no retry — the same split the real page makes between its
    // 400 body and a transport failure.
    isUnavailable: derived.filterErrorMessage !== null,
    resultCount: derived.resultCount,
    unavailableReason: derived.filterErrorMessage,
  };
}
