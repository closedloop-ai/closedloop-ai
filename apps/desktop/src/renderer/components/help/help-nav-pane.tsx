/**
 * Left pane of the two-pane Help view (FEA-3844 / PRD-555 M2): the `meta.json`
 * nav tree plus a search box.
 *
 * With no query, shows the grouped nav tree (groups → page rows); typing
 * switches to ranked search results from the M1 local index. Selecting either a
 * nav page or a search hit calls `onSelect(path, headingSlug?)` — a hit that
 * matched on a heading carries its slug so the reader deep-links to that section.
 */
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { ScrollArea } from "@closedloop-ai/design-system/components/ui/scroll-area";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { SearchIcon } from "lucide-react";
import type {
  DocsHelpNavGroup,
  DocsHelpSearchHit,
} from "../../../shared/docs-help-contract";
import { DOCS_MATCH_FIELD_LABEL } from "./docs-help-labels";

type HelpNavPaneProps = {
  navGroups: readonly DocsHelpNavGroup[];
  selectedPath: string | null;
  onSelect: (path: string, headingSlug?: string) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchHits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
};

export function HelpNavPane({
  navGroups,
  selectedPath,
  onSelect,
  searchQuery,
  onSearchQueryChange,
  searchHits,
  isSearching,
}: Readonly<HelpNavPaneProps>) {
  const isSearchMode = searchQuery.trim().length > 0;

  return (
    <div className="flex min-h-0 w-72 shrink-0 flex-col border-border/60 border-r">
      <div className="border-border/60 border-b p-3">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--muted-foreground)]"
          />
          <Input
            aria-label="Search documentation"
            className="pl-8"
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Search docs…"
            type="search"
            value={searchQuery}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {isSearchMode ? (
          <HelpSearchResults
            hits={searchHits}
            isSearching={isSearching}
            onSelect={onSelect}
            query={searchQuery}
            selectedPath={selectedPath}
          />
        ) : (
          <HelpNavTree
            navGroups={navGroups}
            onSelect={onSelect}
            selectedPath={selectedPath}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function HelpNavTree({
  navGroups,
  selectedPath,
  onSelect,
}: Readonly<{
  navGroups: readonly DocsHelpNavGroup[];
  selectedPath: string | null;
  onSelect: (path: string, headingSlug?: string) => void;
}>) {
  return (
    <nav aria-label="Documentation" className="flex flex-col gap-4 p-3">
      {navGroups.map((group) => (
        <div className="flex flex-col gap-0.5" key={group.group}>
          <p className="px-2 pb-1 font-medium text-[var(--muted-foreground)] text-xs uppercase tracking-wide">
            {group.group}
          </p>
          {group.pages.map((page) => (
            <button
              aria-current={selectedPath === page.path ? "page" : undefined}
              className={cn(
                "rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                "hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedPath === page.path
                  ? "bg-[var(--accent)] font-medium text-[var(--accent-foreground)]"
                  : "text-[var(--foreground)]"
              )}
              key={page.path}
              onClick={() => onSelect(page.path)}
              type="button"
            >
              {page.title}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function HelpSearchResults({
  hits,
  isSearching,
  query,
  selectedPath,
  onSelect,
}: Readonly<{
  hits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
  query: string;
  selectedPath: string | null;
  onSelect: (path: string, headingSlug?: string) => void;
}>) {
  if (hits.length === 0) {
    return (
      <p className="px-4 py-6 text-[var(--muted-foreground)] text-sm">
        {isSearching ? "Searching…" : `No results for "${query.trim()}".`}
      </p>
    );
  }
  return (
    <ul aria-label="Search results" className="flex flex-col gap-1 p-3">
      {hits.map((hit) => (
        <li key={`${hit.path}#${hit.headingSlug ?? ""}`}>
          <button
            aria-current={selectedPath === hit.path ? "page" : undefined}
            className={cn(
              "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors",
              "hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
            onClick={() => onSelect(hit.path, hit.headingSlug)}
            type="button"
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 truncate font-medium text-[var(--foreground)] text-sm">
                {hit.title}
              </span>
              <span className="shrink-0 text-[var(--muted-foreground)] text-xs">
                {DOCS_MATCH_FIELD_LABEL[hit.matchField]}
              </span>
            </span>
            {hit.excerpt ? (
              <span className="line-clamp-2 text-[var(--muted-foreground)] text-xs">
                {hit.excerpt}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
