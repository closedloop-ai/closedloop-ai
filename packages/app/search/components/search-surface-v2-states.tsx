"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { CommandItem } from "@repo/design-system/components/ui/command";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { AlertTriangleIcon, Loader2Icon, SearchXIcon } from "lucide-react";
import { SearchSurfaceState } from "../lib/search-surface-model";
import { SearchEmptyOnRamp } from "./search-empty-onramp";
import { SearchResultsSkeleton } from "./search-results-skeleton";
import {
  type SearchSurfaceMode,
  SearchSurfaceModeKind,
} from "./search-surface-v2-props";

/**
 * ISS-9414 — the non-`Ready` states, said the same way on both shells.
 *
 * The copy is module-level, so a page and a palette cannot make two different
 * claims about one read. Chrome differs: a route body has room for the designed
 * `EmptyState`, a palette row does not.
 */

type NonReadyState = Exclude<
  SearchSurfaceState,
  typeof SearchSurfaceState.Ready
>;

/** What every state body needs, whichever mode renders it. */
type StateBodyProps = {
  onRetry: () => void;
  query: string;
  state: NonReadyState;
  unavailableReason: string | null;
};

export function SearchSurfaceStates({
  mode,
  ...body
}: Readonly<StateBodyProps & { mode: SearchSurfaceMode }>) {
  if (mode.kind === SearchSurfaceModeKind.Overlay) {
    return <OverlayState mode={mode} {...body} />;
  }
  return <PageState mode={mode} {...body} />;
}

function PageState({
  mode,
  onRetry,
  query,
  state,
  unavailableReason,
}: Readonly<
  StateBodyProps & {
    mode: Extract<
      SearchSurfaceMode,
      { kind: typeof SearchSurfaceModeKind.Page }
    >;
  }
>) {
  switch (state) {
    case SearchSurfaceState.NotRun:
      return <SearchEmptyOnRamp onRunExample={mode.onRunExample} />;
    case SearchSurfaceState.Loading:
      return <SearchResultsSkeleton loadingLabel={LOADING_LABEL} />;
    case SearchSurfaceState.Unavailable:
      return (
        <EmptyState
          action={
            unavailableReason === null ? (
              <Button
                onClick={onRetry}
                size="sm"
                type="button"
                variant="outline"
              >
                {RETRY_LABEL}
              </Button>
            ) : undefined
          }
          description={unavailableReason ?? UNAVAILABLE_DESCRIPTION}
          icon={AlertTriangleIcon}
          title={
            unavailableReason === null
              ? UNAVAILABLE_TITLE
              : REJECTED_QUERY_TITLE
          }
        />
      );
    case SearchSurfaceState.NoResults:
      return (
        <EmptyState
          description={noResultsDescription(query, {
            canRemoveFilters: true,
          })}
          icon={SearchXIcon}
          title={NO_RESULTS_TITLE}
        />
      );
    default:
      return assertEveryStateRendered(state);
  }
}

function OverlayState({
  mode,
  onRetry,
  query,
  state,
  unavailableReason,
}: Readonly<
  StateBodyProps & {
    mode: Extract<
      SearchSurfaceMode,
      { kind: typeof SearchSurfaceModeKind.Overlay }
    >;
  }
>) {
  switch (state) {
    case SearchSurfaceState.NotRun:
      return <p className={OVERLAY_LINE_CLASS}>{mode.notRunPrompt}</p>;
    case SearchSurfaceState.Loading:
      return (
        <p className={OVERLAY_LINE_CLASS}>
          <Loader2Icon
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin"
          />
          {LOADING_LABEL}
        </p>
      );
    case SearchSurfaceState.Unavailable:
      return (
        <>
          <p className={OVERLAY_LINE_CLASS}>
            {unavailableReason === null
              ? UNAVAILABLE_TITLE
              : `${REJECTED_QUERY_TITLE}: ${unavailableReason}`}
          </p>
          {/* A `cmdk` option, not a loose button: `CommandList` is a listbox
              whose arrow keys walk options only, so a bare control inside it
              is unreachable from the keyboard the palette is driven by. */}
          {unavailableReason === null ? (
            <CommandItem onSelect={onRetry} value={RETRY_ITEM_VALUE}>
              {RETRY_LABEL}
            </CommandItem>
          ) : null}
        </>
      );
    case SearchSurfaceState.NoResults:
      return (
        <p className={OVERLAY_LINE_CLASS}>
          <span className="shrink-0">{NO_RESULTS_TITLE}</span>
          <span className="min-w-0 truncate">
            {noResultsDescription(query, { canRemoveFilters: false })}
          </span>
        </p>
      );
    default:
      return assertEveryStateRendered(state);
  }
}

/**
 * A sixth `SearchSurfaceState` fails `tsc` here rather than falling into
 * whichever branch happens to be last — which, before this guard, would have
 * silently claimed an empty corpus in BOTH modes.
 */
function assertEveryStateRendered(state: never): never {
  throw new Error(`SearchSurfaceV2 renders no body for state "${state}"`);
}

const OVERLAY_LINE_CLASS =
  "flex items-center gap-2 px-3 py-6 text-muted-foreground text-sm";

/** Kept out of the visible text so cmdk cannot match it against a query. */
const RETRY_ITEM_VALUE = "search-surface-retry";

/**
 * Names the state as a FAILURE TO ANSWER, never as an answer: this and
 * {@link NO_RESULTS_TITLE} must be different sentences, because the reader's
 * next move differs — retry, versus broaden the query.
 */
const UNAVAILABLE_TITLE = "Couldn't load results";
/**
 * The other unavailable: the transport worked and the SERVER refused the query.
 * Nothing is retryable until the query changes, so this branch renders the
 * server's own reason and no retry at all.
 */
const REJECTED_QUERY_TITLE = "Couldn't run that query";
const UNAVAILABLE_DESCRIPTION =
  "Something went wrong loading these results. Your query is fine; this is on our end.";
const RETRY_LABEL = "Try again";
const NO_RESULTS_TITLE = "No results";
const LOADING_LABEL = "Searching…";

/**
 * Echoes the query back, so a reader sees WHICH question came back empty.
 *
 * The filter clause is PAGE-only (marisolashgrove review). The web page carries the
 * `type:` tokens and the type control beside this body; the Desktop palette
 * carries neither, so telling a palette reader to remove a filter names an
 * affordance that is not on their screen — and the next move it suggests is one
 * they cannot make.
 */
function noResultsDescription(
  query: string,
  { canRemoveFilters }: { canRemoveFilters: boolean }
): string {
  const nextMove = canRemoveFilters
    ? "Try broadening the terms or removing a filter."
    : "Try broadening the terms.";
  return `Nothing matched “${query}”. ${nextMove}`;
}
