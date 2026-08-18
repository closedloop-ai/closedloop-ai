"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useMemo, useState } from "react";
import {
  DEMO_STATES,
  DemoState,
  mockResults,
  type ResultHit,
  TOO_MANY_TOTAL,
} from "../mock";
import { activeTypeKinds } from "../search-model";
import { AppShell } from "./app-shell";
import { EmptyOnRamp } from "./empty-onramp";
import { QueryBar } from "./query-bar";
import {
  NoResults,
  ResultsBody,
  ResultsLoadError,
  ResultsSkeleton,
} from "./results-list";

// A safe-to-show filter-error message, mirroring the shape the real backend
// returns for a bad token (the 400 body surfaced by useSearchPanelState).
const FILTER_ERROR_MESSAGE = "Unknown status value: huge";

// How many rows the "too many" state shows per page; Load more adds another
// page. The count line reports N of TOO_MANY_TOTAL so the state stays honest.
const TOO_MANY_PAGE_SIZE = 8;

// What the context strip says while a filter error keeps the last-good rows on
// screen: it names what the user is looking at without claiming a count for the
// query that failed.
const STALE_RESULTS_TEXT = "Showing last results";

// The stateful driver. It owns the query string (the JQL model's single source
// of truth) and a demo-state selector so a reviewer can walk all six states
// without a backend. In production these states are derived from the real
// query result, not picked.
export function SearchWorkspace() {
  const [demoState, setDemoState] = useState<DemoState>(DemoState.Results);
  const [query, setQuery] = useState("agent");
  // How many rows the "too many" state reveals; Load more grows this so the
  // button drives a real change instead of being wired to nothing.
  const [visibleCount, setVisibleCount] = useState(TOO_MANY_PAGE_SIZE);

  // The results shown for the active demo state. Type tokens in the bar filter
  // the mock corpus so the Type control visibly changes the list.
  const visibleResults = useMemo(
    () => filterByTypeTokens(mockResults, query),
    [query]
  );

  const selectDemoState = (next: DemoState) => {
    const meta = DEMO_STATES.find((entry) => entry.state === next);
    if (!meta) {
      return;
    }
    setDemoState(next);
    setQuery(meta.query);
    setVisibleCount(TOO_MANY_PAGE_SIZE);
  };

  // Re-running the query derives the demo state from the query so the body never
  // contradicts the bar: an empty bar lands the on-ramp, a non-empty bar runs a
  // live result. Transient error/loading demo states also resolve to a result
  // (a bad token is fixed by editing the query, not by staying stuck). The
  // filter-error state is the one exception a reviewer picks explicitly; a real
  // submit clears it because the query changed.
  const onSubmit = (submitted: string) => {
    setDemoState(
      submitted.trim().length === 0 ? DemoState.Empty : DemoState.Results
    );
  };

  // The filter error sits ABOVE the last-good results, not over a void: the user
  // is mid-edit on their query, so we keep what they were reading on screen.
  const filterErrorMessage =
    demoState === DemoState.FilterError ? FILTER_ERROR_MESSAGE : undefined;

  return (
    <AppShell
      actions={
        <DemoStateSwitcher onSelect={selectDemoState} value={demoState} />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          <h1 className="sr-only">Search results</h1>
          <QueryBar
            filterErrorMessage={filterErrorMessage}
            onChange={setQuery}
            onSubmit={onSubmit}
            value={query}
          />
          <SearchBody
            demoState={demoState}
            onClearQuery={() => selectDemoState(DemoState.Empty)}
            onLoadMore={() =>
              setVisibleCount((count) => count + TOO_MANY_PAGE_SIZE)
            }
            onRetry={() => setDemoState(DemoState.Results)}
            onRunExample={(next) => {
              setQuery(next);
              setDemoState(DemoState.Results);
            }}
            query={query}
            results={visibleResults}
            visibleCount={visibleCount}
          />
        </div>
      </div>
    </AppShell>
  );
}

type SearchBodyProps = {
  demoState: DemoState;
  query: string;
  results: readonly ResultHit[];
  visibleCount: number;
  onRetry: () => void;
  onClearQuery: () => void;
  onRunExample: (query: string) => void;
  onLoadMore: () => void;
};

function SearchBody({
  demoState,
  query,
  results,
  visibleCount,
  onRetry,
  onClearQuery,
  onRunExample,
  onLoadMore,
}: Readonly<SearchBodyProps>) {
  if (demoState === DemoState.Empty) {
    return <EmptyOnRamp onRunExample={onRunExample} />;
  }
  if (demoState === DemoState.Loading) {
    return (
      <>
        <ContextStrip liveMessage="Loading results" text="Searching…" />
        <ResultsSkeleton />
      </>
    );
  }
  if (demoState === DemoState.LoadError) {
    return <ResultsLoadError onRetry={onRetry} />;
  }
  // FilterError keeps the last-good results on screen (the bar owns the error
  // banner above them); NoResults / an empty corpus show the empty state.
  const isEmptyCorpus =
    demoState !== DemoState.FilterError && results.length === 0;
  if (demoState === DemoState.NoResults || isEmptyCorpus) {
    return <NoResults onClear={onClearQuery} query={query} />;
  }

  return (
    <ResultsView
      demoState={demoState}
      onLoadMore={onLoadMore}
      results={results}
      visibleCount={visibleCount}
    />
  );
}

// The results body + its context strip. In the "too many" state the count is
// honest about the total behind Load more ("Showing 8 of 1,240"), and Load more
// actually reveals more mock rows via the parent's visibleCount so the button is
// never wired to nothing.
function ResultsView({
  demoState,
  results,
  visibleCount,
  onLoadMore,
}: Readonly<{
  demoState: DemoState;
  results: readonly ResultHit[];
  visibleCount: number;
  onLoadMore: () => void;
}>) {
  const tooMany = demoState === DemoState.TooMany;
  const total = tooMany ? TOO_MANY_TOTAL : results.length;
  const shown = tooMany
    ? Math.min(visibleCount, results.length)
    : results.length;
  const hits = tooMany ? results.slice(0, shown) : results;
  // A filter error means the query never ran, so the rows below are the LAST
  // GOOD set. Counting them here would attribute them to the failed query, so
  // the strip names them instead — a count and "unavailable" must not read the
  // same. The bar owns the reason.
  const isStale = demoState === DemoState.FilterError;
  const countText = contextStripText({ isStale, tooMany, shown, total });
  // Load more reveals more mock rows; the button hides once the prototype's
  // corpus is exhausted (the honest ceiling behind the fake total).
  const canLoadMore = tooMany && shown < results.length;

  return (
    <>
      <ContextStrip
        liveMessage={isStale ? countText : `${countText} for your query`}
        text={countText}
      />
      <ResultsBody hits={hits} />
      {canLoadMore ? (
        <div className="flex justify-center pt-2">
          <Button onClick={onLoadMore} type="button" variant="outline">
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

// The thin result-context strip: an honest count, announced to assistive tech
// via aria-live so a screen reader hears the result count change on re-query.
function ContextStrip({
  text,
  liveMessage,
}: Readonly<{ text: string; liveMessage: string }>) {
  return (
    <div className="flex items-center justify-between border-border border-b pb-2">
      <span className="text-muted-foreground text-sm">{text}</span>
      <span aria-live="polite" className="sr-only">
        {liveMessage}
      </span>
    </div>
  );
}

// A prototype-only affordance: lets a reviewer jump to any of the six states.
// This control does NOT exist in the production surface; states are derived
// from the real query result there.
function DemoStateSwitcher({
  value,
  onSelect,
}: Readonly<{ value: DemoState; onSelect: (state: DemoState) => void }>) {
  return (
    <ToggleGroup
      className="flex-wrap"
      onValueChange={(next) => {
        if (next) {
          onSelect(next as DemoState);
        }
      }}
      size="sm"
      type="single"
      value={value}
      variant="outline"
    >
      {DEMO_STATES.map((entry) => (
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

// What the context strip says above the rows. Loading, stale-after-a-failed
// filter, a capped page, and a plain count are four different facts and each
// gets its own line — the stale case never borrows the previous query's number.
function contextStripText({
  isStale,
  tooMany,
  shown,
  total,
}: Readonly<{
  isStale: boolean;
  tooMany: boolean;
  shown: number;
  total: number;
}>): string {
  if (isStale) {
    return STALE_RESULTS_TEXT;
  }
  if (tooMany) {
    return `Showing ${shown} of ${total.toLocaleString()}`;
  }
  return `${total} ${total === 1 ? "result" : "results"}`;
}

// Filter the mock corpus by any `type:` tokens in the query, mirroring the
// OR-within-type semantics of the real grammar (no token = all types).
function filterByTypeTokens(
  hits: readonly ResultHit[],
  query: string
): ResultHit[] {
  const kinds = activeTypeKinds(query);
  if (kinds.length === 0) {
    return [...hits];
  }
  return hits.filter((hit) => kinds.includes(hit.kind));
}
