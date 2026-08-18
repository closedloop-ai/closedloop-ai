"use client";

import type { SearchHit } from "@repo/api/src/types/search";
import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { PHASE_1_SEARCH_ENTITY_TYPES } from "@repo/api/src/types/search-entity-kind";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  Loader2Icon,
  SearchXIcon,
} from "lucide-react";
import { formatDate } from "../../shared/lib/date-utils";
import type { SnippetSegment } from "../lib/search-display";
import {
  parseSnippetSegments,
  SEARCH_ENTITY_TYPE_ICONS,
  SEARCH_ENTITY_TYPE_LABELS,
  searchHitOrgRelativeRoute,
} from "../lib/search-display";
import { SnippetHighlight } from "./snippet-highlight";

type UnifiedSearchResultsProps = {
  /** Ranked heterogeneous hits from the FTS response. */
  results: SearchHit[];
  /** True while the query is in flight (first load). */
  isLoading: boolean;
  /** True when the query settled in an error state. */
  isError: boolean;
  /**
   * A safe-to-show message for a malformed inline filter (the 400 body), shown
   * inline so the user can fix the query. Absent for non-filter errors, which
   * fall back to the generic error copy in the results body.
   */
  filterErrorMessage?: string;
  /** Currently-selected type facets; empty means "all Phase-1 types". */
  activeTypes: SearchEntityType[];
  /** Toggle a single type facet on/off. */
  onToggleType: (type: SearchEntityType) => void;
  /**
   * Called when a result link is activated, in addition to the link's own
   * navigation. A surface hosted inside a dismissible container (the mobile
   * search sheet) uses this to close itself so activating a same-route hit does
   * not leave the overlay open over the page it is already on.
   */
  onSelectResult?: () => void;
  /**
   * Drop the removable "active facets" chip row. The picker row already shows
   * selected state via `aria-pressed`, so on a space-constrained surface (the
   * mobile sheet) the second row is the applied state said twice. The `/search`
   * page keeps both rows (default), where the width is available.
   */
  hideActiveFacetChips?: boolean;
  /**
   * Drop the built-in type-facet chip strip AND the active-facet chip row
   * entirely (FEA-4134). The redesigned `/search` page owns type filtering
   * through the mouse-first `SearchTypeControl` beside the query bar (which
   * writes inline `type:` tokens), so the in-list facet strip would be a second,
   * conflicting source of truth. The mobile sheet keeps the facet strip
   * (default), where it is the only type control.
   */
  hideTypeFacets?: boolean;
  /**
   * Retry a non-filter (network/5xx) load error. When provided, the error state
   * renders a designed retry affordance instead of the plain message; the mobile
   * sheet omits it (a re-query fixes it there). FEA-4134.
   */
  onRetry?: () => void;
};

/**
 * FEA-3873/FEA-3930 cross-entity result list. Renders the ranked heterogeneous
 * {@link SearchHit}s in one list: a type facet chip, a highlighted `ts_headline`
 * snippet, and a deep link per hit. Above the list sits the artifact-type facet
 * control, a toggle-chip row mapping to the query `types[]` param, plus a
 * removable-chip row for the active facets and an inline banner for a malformed
 * inline filter. Shared across the web app and the desktop renderer via
 * `@repo/app`.
 */
export function UnifiedSearchResults({
  results,
  isLoading,
  isError,
  filterErrorMessage,
  activeTypes,
  onToggleType,
  onSelectResult,
  hideActiveFacetChips = false,
  hideTypeFacets = false,
  onRetry,
}: UnifiedSearchResultsProps) {
  const showActiveFacetChips =
    !(hideTypeFacets || hideActiveFacetChips) && activeTypes.length > 0;
  return (
    <div className="flex flex-col gap-4">
      {hideTypeFacets ? null : (
        <SearchTypeFacets
          activeTypes={activeTypes}
          onToggleType={onToggleType}
        />
      )}
      {showActiveFacetChips ? (
        <ActiveFacetChips activeTypes={activeTypes} onRemove={onToggleType} />
      ) : null}
      {/* A malformed filter means the query never ran, so there is no result set
          to describe and the banner is the whole story (ISS-4665). Rendering the
          body here claimed "No results — nothing matched your query", blaming
          the corpus for a query the server rejected: the hook mints a new key
          per query string, so a 400 leaves `results` empty every time and that
          empty-state branch was the one the user actually landed on. Suppressing
          the body outright, rather than masking `isError` into it, is what keeps
          a later branch from finding a new way to make a claim under a 400. */}
      {filterErrorMessage ? (
        <FilterErrorBanner message={filterErrorMessage} />
      ) : (
        <UnifiedResultsBody
          isError={isError}
          isLoading={isLoading}
          onRetry={onRetry}
          onSelectResult={onSelectResult}
          results={results}
        />
      )}
    </div>
  );
}

/**
 * The active type facets as removable chips, so a selected facet is both visible
 * as an applied filter and one click to drop. Complements the toggle-chip row:
 * that row is the picker, this row is the "what's applied" summary. Only shown
 * when at least one facet is active (all-off reads as "all types").
 */
function ActiveFacetChips({
  activeTypes,
  onRemove,
}: Readonly<{
  activeTypes: SearchEntityType[];
  onRemove: (type: SearchEntityType) => void;
}>) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1 border-0 p-0">
      <legend className="sr-only">Active type filters</legend>
      {activeTypes.map((type) => (
        <FilterChip
          key={type}
          label={SEARCH_ENTITY_TYPE_LABELS[type]}
          onRemove={() => onRemove(type)}
        />
      ))}
    </fieldset>
  );
}

/**
 * Inline banner for a malformed inline filter (the backend 400). Surfaces the
 * exact, safe-to-show reason (e.g. "Unknown priority value: huge") so the user
 * can correct the query instead of facing a generic failure.
 */
function FilterErrorBanner({ message }: Readonly<{ message: string }>) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/12 px-3 py-2 text-destructive text-sm"
      role="alert"
    >
      <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function UnifiedResultsBody({
  results,
  isLoading,
  isError,
  onSelectResult,
  onRetry,
}: Readonly<{
  results: SearchHit[];
  isLoading: boolean;
  isError: boolean;
  onSelectResult?: () => void;
  onRetry?: () => void;
}>) {
  if (isError) {
    return <ResultsLoadError onRetry={onRetry} />;
  }

  if (isLoading) {
    return <ResultsSkeleton />;
  }

  if (results.length === 0) {
    return (
      <EmptyState
        description="Nothing matched your query. Try broadening the terms or removing a filter."
        icon={SearchXIcon}
        title="No results"
      />
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {results.map((hit) => (
        <SearchHitRow
          hit={hit}
          key={`${hit.entityType}:${hit.entityId}`}
          onSelect={onSelectResult}
        />
      ))}
    </ul>
  );
}

/**
 * Loading: skeleton rows matching the result-row rhythm (icon + title + snippet
 * line + meta) so the layout does not jump when results land (FEA-4134). A
 * spinner is announced to assistive tech; the visual rows are decorative.
 */
function ResultsSkeleton() {
  const rows = [0, 1, 2, 3, 4];
  return (
    <>
      <Loader2Icon aria-label="Loading search results" className="sr-only" />
      <ul aria-hidden="true" className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li className="flex gap-3 px-2 py-3" key={row}>
            <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-32" />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A non-filter (network/5xx) load error: an honest inline message plus a retry
 * when the host wired one, never a dead spinner (FEA-4134). Without `onRetry`
 * (the mobile sheet), the message stands alone and a re-query fixes it.
 */
function ResultsLoadError({ onRetry }: Readonly<{ onRetry?: () => void }>) {
  return (
    <EmptyState
      action={
        onRetry ? (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        ) : undefined
      }
      description="Something went wrong loading these results. Your query is fine; this is on our end."
      icon={AlertTriangleIcon}
      title="Couldn't load results"
    />
  );
}

function SearchTypeFacets({
  activeTypes,
  onToggleType,
}: Readonly<{
  activeTypes: SearchEntityType[];
  onToggleType: (type: SearchEntityType) => void;
}>) {
  // Empty activeTypes means "all types", render every chip in the selected
  // look so "no filter" reads as all-on, not as everything deselected.
  const allTypesActive = activeTypes.length === 0;

  return (
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Filter results by type</legend>
      {PHASE_1_SEARCH_ENTITY_TYPES.map((type) => {
        const isActive = allTypesActive || activeTypes.includes(type);
        return (
          <Chip
            aria-pressed={isActive}
            asChild
            interactive
            key={type}
            variant={isActive ? "accent" : "muted"}
          >
            {/* Hold the 44px `--tap-min` floor on touch — these facet chips are
                the primary filter control on the mobile search surface; the
                dense mouse height is unchanged. */}
            <button
              className="touch:min-h-tap-min"
              onClick={() => onToggleType(type)}
              type="button"
            >
              {SEARCH_ENTITY_TYPE_LABELS[type]}
            </button>
          </Chip>
        );
      })}
    </fieldset>
  );
}

function SearchHitRow({
  hit,
  onSelect,
}: Readonly<{ hit: SearchHit; onSelect?: () => void }>) {
  const buildOrgPath = useOrgPath();
  const segments = parseSnippetSegments(hit.snippet);
  const body = <SearchHitBody hit={hit} segments={segments} />;

  // Build the real web route from the hit's route fields (Phase-2): documents by
  // type + slug, projects team-scoped, loops by id. A hit missing the data to
  // build a safe route yields null and renders as a plain (non-link) row so a
  // click never lands on a 404.
  const route = searchHitOrgRelativeRoute(hit);
  if (route === null) {
    return (
      <li>
        <div className="flex gap-3 px-2 py-3">{body}</div>
      </li>
    );
  }

  const href = buildOrgPath(route);
  return (
    <li>
      <Link
        className="flex gap-3 rounded-md px-2 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
        href={href}
        // A hosting sheet closes itself here so activating a hit whose route is
        // already current still dismisses the overlay (Link alone wouldn't, no
        // navigation fires). The row stays a real <Link> for middle/cmd-click.
        onClick={onSelect}
      >
        {body}
      </Link>
    </li>
  );
}

/**
 * One result row's content (FEA-4134, faithful to the FEA-4031 prototype): a
 * fixed-width kind icon leads the row so the title's left edge is identical on
 * every row, then a column with the title, the highlighted snippet, and a meta
 * line opening with the type NAME followed by Updated. Projection-only fields —
 * no per-row Status/PRs/Team (FEA-4134 OQ#2: matched the current row projection,
 * per-row metadata deferred).
 */
function SearchHitBody({
  hit,
  segments,
}: Readonly<{ hit: SearchHit; segments: SnippetSegment[] }>) {
  const Icon = SEARCH_ENTITY_TYPE_ICONS[hit.entityType];
  return (
    <>
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium text-foreground">
          {hit.title}
        </span>
        <p className="line-clamp-2 text-muted-foreground text-sm">
          <SnippetHighlight segments={segments} />
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">
            {SEARCH_ENTITY_TYPE_LABELS[hit.entityType]}
          </span>
          <span>Updated {formatDate(hit.updatedAt)}</span>
        </div>
      </div>
    </>
  );
}
