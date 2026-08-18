"use client";

import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SearchTypeahead } from "@repo/app/search/components/search-typeahead";
import { UnifiedSearchResults } from "@repo/app/search/components/unified-search-results";
import {
  MIN_UNIFIED_QUERY_LENGTH,
  useSearchPanelState,
} from "@repo/app/search/hooks/use-search";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/design-system/components/ui/sheet";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

/**
 * Touch-reachable global search for `< md`, at parity with the desktop unified
 * search (FEA-3930). Desktop opens the `cmd+k` CommandPalette and the sidebar
 * typeahead; a phone has neither, so this surfaces a visible header button that
 * opens a full-width sheet built from the SAME unified pieces the sidebar and
 * the `/search` page use: the intellisense-aware {@link SearchTypeahead} input
 * (the `@`/`:` query language plus prefix suggestions) and the ranked,
 * navigable {@link UnifiedSearchResults} list with artifact-type facets. A hit
 * lands on its real detail route and closes the sheet. The Radix Dialog under
 * the sheet owns focus trap, Escape-to-close, and the accessible title.
 */
export function MobileSearchOverlay() {
  const [open, setOpen] = useState(false);
  // Bumped on each open so the sheet's query/facets/input reset per open via
  // `key` — WITHOUT unmounting SheetContent from the tree, which would skip the
  // Sheet's built-in exit animation (Radix runs it from the closed data-state).
  const [openCount, setOpenCount] = useState(0);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpenCount((count) => count + 1);
    }
    setOpen(next);
  };

  return (
    <Sheet onOpenChange={handleOpenChange} open={open}>
      <Button
        aria-label="Search"
        // Header search entry for touch only. Desktop keeps `cmd+k`, so this is
        // hidden at `md+` to avoid a second, redundant control there.
        className="md:hidden"
        onClick={() => handleOpenChange(true)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <SearchIcon className="size-4" />
      </Button>
      {/* Radix gates mount/unmount on `open` and owns the exit animation; the
          per-open `key` gives fresh local state each time it reopens. */}
      <MobileSearchSheet key={openCount} onClose={() => setOpen(false)} />
    </Sheet>
  );
}

function MobileSearchSheet({ onClose }: Readonly<{ onClose: () => void }>) {
  const buildOrgPath = useOrgPath();
  const { navigate } = useNavigation();
  const [query, setQuery] = useState("");
  const [activeTypes, setActiveTypes] = useState<SearchEntityType[]>([]);

  // Mirrors the desktop `/search` results panel: fulltext ranked hits over the
  // whole Phase-1 corpus, filtered by the active type facets, with the shared
  // 400-filter-error classification. Idle until the query clears the 2-char
  // floor (the hook's own `enabled` gate).
  const { results, isLoading, isError, filterErrorMessage } =
    useSearchPanelState({ query, types: activeTypes });

  // Show the results surface only once the query clears the SAME floor the hook
  // fires on; below it the hook is idle, so a 1-char query would otherwise show
  // a false "No results" state for a request that never ran.
  const showResults = query.trim().length >= MIN_UNIFIED_QUERY_LENGTH;

  const handleToggleType = (type: SearchEntityType) => {
    setActiveTypes((current) =>
      current.includes(type)
        ? current.filter((t) => t !== type)
        : [...current, type]
    );
  };

  // Enter on the free-text query jumps to the full `/search` page (the same
  // destination the sidebar submit uses), carrying the active type facets as the
  // repeated `types` params the page reads, and closes the sheet.
  const handleSubmit = (submitted: string) => {
    const next = submitted.trim();
    if (!next) {
      return;
    }
    onClose();
    const params = new URLSearchParams({ q: next });
    for (const type of activeTypes) {
      params.append("types", type);
    }
    // useOrgPath (not raw slug interpolation) builds the org-scoped href so a
    // pre-hydration empty slug can't produce a protocol-relative `//search`.
    navigate(buildOrgPath(`/search?${params.toString()}`));
  };

  return (
    <SheetContent
      // Full-height top sheet: mobile search takes the whole screen (no dead
      // dimmed band), the field pins to the top because the soft keyboard rises
      // from the bottom, and the results scroll beneath it.
      className="h-dvh gap-0 p-0"
      // The pill's own clear-X sits in the top-right; suppress the Sheet's
      // built-in close-X so two X's don't stack a thumb-width apart. Escape and
      // an overlay tap still dismiss the sheet.
      hideClose
      side="top"
    >
      <SheetHeader className="gap-0 px-3 pt-3 pb-2">
        <SheetTitle className="sr-only">Search</SheetTitle>
        <SheetDescription className="sr-only">{SEARCH_PROMPT}</SheetDescription>
        <SearchTypeahead
          onClear={() => setQuery("")}
          // A chosen prefix hit already routes inside SearchTypeahead; closing
          // the sheet is all that is left.
          onSelectHit={() => onClose()}
          onSubmit={handleSubmit}
          onValueChange={setQuery}
          showClear={query.length > 0}
          // The sheet renders its own inline UnifiedSearchResults list; suppress
          // the typeahead's floating FTS dropdown so two result surfaces don't
          // stack. The `:`/`@` intellisense overlay stays (it edits the query).
          suppressFtsDropdown
          value={query}
        />
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {showResults ? (
          <UnifiedSearchResults
            activeTypes={activeTypes}
            filterErrorMessage={filterErrorMessage}
            // Drop the "active facets" chip row on this narrow surface: the
            // picker row already shows selected state, so it would be the applied
            // state said twice above the first result.
            hideActiveFacetChips
            isError={isError}
            isLoading={isLoading}
            // Close the sheet when a result link is activated, so a hit that is
            // already the current route still dismisses the overlay.
            onSelectResult={onClose}
            onToggleType={handleToggleType}
            results={results}
          />
        ) : (
          <p className="px-2 py-8 text-center text-muted-foreground text-sm">
            {SEARCH_PROMPT}
          </p>
        )}
      </div>
    </SheetContent>
  );
}

// Pre-search prompt, shared by the visible copy and the sr-only description so
// the two never drift. Names the corpus the facets actually cover and teaches
// the `:`/`@` query language sighted users can't otherwise discover.
//
// ISS-4477 retires the Loops *nav & UI* only; it deliberately leaves the search
// corpus untouched — the `Loop` search facet (`SearchEntityType.Loop`) still
// ships a "Loop" type token and label, and Loop hits still deep-link to
// `/loops/<id>`. So "loops" stays in this prompt: dropping it would undersell a
// corpus the facets still cover. Remove it here only when the Loop search facet
// itself goes.
const SEARCH_PROMPT =
  "Search documents, projects, loops, sessions, and more. Type : to filter by field, @ to find a person.";
