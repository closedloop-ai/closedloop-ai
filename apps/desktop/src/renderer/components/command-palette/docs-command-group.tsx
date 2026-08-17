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
 */
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  CommandGroup,
  CommandItem,
} from "@closedloop-ai/design-system/components/ui/command";
import { BookOpenIcon } from "lucide-react";
import type { DocsHelpSearchHit } from "../../../shared/docs-help-contract";
import { DOCS_MATCH_FIELD_LABEL } from "../help/docs-help-labels";
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
  const { hits, isSearching } = useDocsCommandSearch(query);
  const hasQuery = query.trim().length > 0;

  if (!hasQuery) {
    return null;
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
