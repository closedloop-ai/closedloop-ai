/**
 * The "Docs" result group of the desktop command palette (FEA-3845 / PRD-555 M3).
 *
 * Debounces the palette query into the M1 `docsHelp.search` IPC and renders the
 * ranked hits as a `CommandGroup` of `CommandItem`s — each showing the page
 * title, the matched-field facet, and a snippet. Selecting a hit calls
 * `onSelectDoc(path, headingSlug?)`, which the palette turns into a Help-view
 * navigation. Empty query and no-results render nothing here (the palette's
 * `CommandEmpty` owns the empty-state copy); a running search shows an inline
 * "Searching…" affordance so the palette never looks stuck.
 *
 * ISS-10044: a REJECTED search gets its own row for the same reason the running
 * one does. `useDocsCommandSearch` has reported `hasFailed` since ISS-9414 and
 * this group dropped it, so a failed search fell through to `CommandEmpty` and
 * the palette answered `No documentation matches "…"` — a claim about the docs,
 * for a query that never reached the index.
 */

import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  CommandGroup,
  CommandItem,
} from "@closedloop-ai/design-system/components/ui/command";
import {
  DOCS_HELP_SEARCH_FAILED_TITLE,
  DOCS_MATCH_FIELD_LABEL,
} from "@repo/app/help/lib/docs-help-labels";
import { BookOpenIcon, TriangleAlertIcon } from "lucide-react";
import type { DocsHelpSearchHit } from "../../../shared/docs-help-contract";
import { useDocsCommandSearch } from "./use-docs-command-search";

type DocsCommandGroupProps = {
  query: string;
  /** Open the Help view at this page (and heading anchor, if the hit was one). */
  onSelectDoc: (path: string, headingSlug?: string) => void;
};

/** Stable per-hit key/value — a page can appear twice under different anchors. */
function hitKey(hit: DocsHelpSearchHit): string {
  return `${hit.path}#${hit.headingSlug ?? ""}`;
}

export function DocsCommandGroup({
  query,
  onSelectDoc,
}: Readonly<DocsCommandGroupProps>) {
  const { hasFailed, hits, isSearching, retry } = useDocsCommandSearch(query);
  const hasQuery = query.trim().length > 0;

  if (!hasQuery) {
    return null;
  }

  // Before the hit count: a rejection arrives as zero hits, and rendering
  // nothing here hands the query to `CommandEmpty`'s no-matches sentence.
  if (hasFailed) {
    return (
      <CommandGroup heading="Docs">
        <p className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-sm">
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
          {DOCS_HELP_SEARCH_FAILED_TITLE}
        </p>
        {/* A `cmdk` option, not a loose button: `CommandList` is a listbox
            whose arrow keys walk options only, so a bare control inside it is
            unreachable from the keyboard the palette is driven by. */}
        <CommandItem onSelect={retry} value={DOCS_SEARCH_RETRY_ITEM_VALUE}>
          {DOCS_SEARCH_RETRY_LABEL}
        </CommandItem>
      </CommandGroup>
    );
  }

  if (hits.length === 0) {
    // While the debounced search is in flight, show progress instead of letting
    // the palette's CommandEmpty flash a premature "no results".
    if (isSearching) {
      return (
        <CommandGroup heading="Docs">
          <CommandItem disabled value="docs-searching">
            <BookOpenIcon aria-hidden />
            <span className="text-[var(--muted-foreground)]">Searching…</span>
          </CommandItem>
        </CommandGroup>
      );
    }
    return null;
  }

  return (
    <CommandGroup heading="Docs">
      {hits.map((hit) => (
        <CommandItem
          key={hitKey(hit)}
          onSelect={() => onSelectDoc(hit.path, hit.headingSlug)}
          value={hitKey(hit)}
        >
          <BookOpenIcon aria-hidden />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate font-medium">{hit.title}</span>
              <Badge className="shrink-0" variant="secondary">
                {DOCS_MATCH_FIELD_LABEL[hit.matchField]}
              </Badge>
            </span>
            {hit.excerpt ? (
              <span className="line-clamp-1 text-[var(--muted-foreground)] text-xs">
                {hit.excerpt}
              </span>
            ) : null}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Kept out of the visible text so cmdk cannot match it against a query. */
const DOCS_SEARCH_RETRY_ITEM_VALUE = "docs-search-retry";

/**
 * Spelled as the flag-ON sibling spells it (`RETRY_LABEL` in
 * `search-surface-v2-states.tsx`), so one palette does not name the same action
 * two ways across a flag it is the reader's accident to be on either side of.
 */
export const DOCS_SEARCH_RETRY_LABEL = "Try again";
