"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { cn } from "@repo/design-system/lib/utils";
import { LibraryBigIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import {
  DOCS_HELP_SEARCH_FAILED_DETAIL,
  DOCS_HELP_SEARCH_FAILED_TITLE,
  DOCS_MATCH_FIELD_LABEL,
} from "../lib/docs-help-labels";
import type {
  DocsHelpNavGroup,
  DocsHelpSearchHit,
} from "../lib/docs-help-payload";
import {
  HELP_SURFACE_V2_NAV_INCOMPLETE_TEST_ID,
  HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID,
} from "../lib/docs-help-test-ids";
import { ViewOnlineAction } from "./help-view-online-action";

/**
 * Left pane of the two-pane Help surface (ISS-10005, mastering PRD-555 M2): the
 * nav tree plus the search box over the host's local docs index.
 *
 * With no query, shows the grouped nav tree; typing switches to ranked results.
 * Selecting either a nav page or a search hit calls `onSelect(path, headingSlug?)`
 * — a hit that matched on a heading carries its slug so the reader deep-links to
 * that section.
 *
 * Refusing a malformed group is the surface's job (`docs-help-payload-guard.ts`);
 * this pane is told HOW MANY were refused so it can say so. A short tree because
 * groups were dropped and a short tree because the bundle is small are different
 * claims, and a reader who cannot find a page needs to know which they face.
 */
type HelpNavPaneProps = {
  navGroups: readonly DocsHelpNavGroup[];
  /** How many groups the read refused. Renders the incomplete-index notice. */
  refusedGroups: number;
  /** The whole tree was unreadable, so no per-group count exists to report. */
  treeUnreadable: boolean;
  /** For the escape hatch offered when the tree cannot be browsed. */
  docsSiteUrl: string;
  selectedPath: string | null;
  onSelect: (path: string, headingSlug?: string) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchHits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
  /** The search never ran. Outranks the hit count, which cannot speak for it. */
  searchFailed: boolean;
  /** ISS-10006 — why THIS host lists no sections. See `DocsHelpCorpusCopy`. */
  navEmptyDetail: string;
};

export function HelpNavPane({
  navEmptyDetail,
  navGroups,
  refusedGroups,
  treeUnreadable,
  docsSiteUrl,
  selectedPath,
  onSelect,
  searchQuery,
  onSearchQueryChange,
  searchHits,
  isSearching,
  searchFailed,
}: Readonly<HelpNavPaneProps>) {
  const isSearchMode = searchQuery.trim().length > 0;

  return (
    <div className={cn(HELP_NAV_PANE_CHROME, "flex min-h-0 flex-col")}>
      <div className="border-border/60 border-b p-3">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
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
            docsSiteUrl={docsSiteUrl}
            hasFailed={searchFailed}
            hits={searchHits}
            isSearching={isSearching}
            onSelect={onSelect}
            query={searchQuery}
            selectedPath={selectedPath}
          />
        ) : (
          <>
            {treeUnreadable || refusedGroups > 0 ? (
              <p
                className="px-3 pt-3 text-muted-foreground text-xs"
                data-testid={HELP_SURFACE_V2_NAV_INCOMPLETE_TEST_ID}
              >
                {navIncompleteMessage({ refusedGroups, treeUnreadable })}
              </p>
            ) : null}
            {navGroups.length === 0 ? (
              <HelpNavUnbrowsable
                detail={navEmptyDetail}
                docsSiteUrl={docsSiteUrl}
              />
            ) : (
              <HelpNavTree
                navGroups={navGroups}
                onSelect={onSelect}
                selectedPath={selectedPath}
              />
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * The tree has nothing to browse. Previously this rendered an empty `<nav>` —
 * the one dead end on this surface with no copy and no way to reach the docs.
 */
function HelpNavUnbrowsable({
  detail,
  docsSiteUrl,
}: Readonly<{ detail: string; docsSiteUrl: string }>) {
  return (
    <div className="p-3">
      <EmptyState
        action={<ViewOnlineAction docsSiteUrl={docsSiteUrl} />}
        description={detail}
        icon={LibraryBigIcon}
        title="Nothing to browse"
        titleAs="h2"
      />
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
          <p className="px-2 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {group.group}
          </p>
          {group.pages.map((page) => (
            <button
              aria-current={selectedPath === page.path ? "page" : undefined}
              className={cn(
                "rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedPath === page.path
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-foreground"
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
  docsSiteUrl,
  hasFailed,
  hits,
  isSearching,
  query,
  selectedPath,
  onSelect,
}: Readonly<{
  docsSiteUrl: string;
  hasFailed: boolean;
  hits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
  query: string;
  selectedPath: string | null;
  onSelect: (path: string, headingSlug?: string) => void;
}>) {
  // ISS-10044. Read BEFORE the hit count, because a rejected search arrives as
  // zero hits and the count below has no way to tell that apart from a corpus
  // that genuinely holds nothing for this query.
  if (hasFailed) {
    return (
      <div className="p-3" data-testid={HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID}>
        <EmptyState
          action={<ViewOnlineAction docsSiteUrl={docsSiteUrl} />}
          description={DOCS_HELP_SEARCH_FAILED_DETAIL}
          icon={TriangleAlertIcon}
          title={DOCS_HELP_SEARCH_FAILED_TITLE}
          titleAs="h2"
        />
      </div>
    );
  }
  if (hits.length === 0) {
    return (
      <p className="px-4 py-6 text-muted-foreground text-sm">
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
              "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
            onClick={() => onSelect(hit.path, hit.headingSlug)}
            type="button"
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 truncate font-medium text-foreground text-sm">
                {hit.title}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {DOCS_MATCH_FIELD_LABEL[hit.matchField]}
              </span>
            </span>
            {hit.excerpt ? (
              <span className="line-clamp-2 text-muted-foreground text-xs">
                {hit.excerpt}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The pane's width and edge, shared with the loading skeleton that stands in for
 * it — the two must agree or the layout jumps when the bundle resolves.
 */
export const HELP_NAV_PANE_CHROME = "w-72 shrink-0 border-border/60 border-r";

/**
 * The three claims this notice can make, kept apart because a reader acts on
 * each differently (marisolashgrove review).
 *
 * `treeUnreadable` used to arrive as `refusedGroups: 1` and print "1 section …",
 * which is the most reassuring sentence available for the case where NOTHING
 * could be read. It gets its own line, and it wins over the count because when
 * the tree is unreadable there are no groups left to have refused.
 */
function navIncompleteMessage({
  refusedGroups,
  treeUnreadable,
}: {
  refusedGroups: number;
  treeUnreadable: boolean;
}): string {
  if (treeUnreadable) {
    return "The docs index couldn't be read, so no sections are listed.";
  }
  return refusedGroups === 1
    ? "1 section of the docs index couldn't be read and isn't listed."
    : `${refusedGroups} sections of the docs index couldn't be read and aren't listed.`;
}
