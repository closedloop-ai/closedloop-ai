"use client";

import type { SearchHit } from "@repo/api/src/types/search";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { Loader2Icon } from "lucide-react";
import {
  parseSnippetSegments,
  SEARCH_ENTITY_TYPE_LABELS,
  searchHitOrgRelativeRoute,
} from "../lib/search-display";
import { SnippetHighlight } from "./snippet-highlight";

/**
 * FEA-3873 prefix-mode FTS suggestion dropdown for the sidebar search box,  * extracted from `search-typeahead.tsx` so the intellisense surface and the
 * free-text-suggestion surface each own one file. Renders ranked cross-entity
 * hits (type chip + highlighted snippet + deep link) as the ARIA listbox popup
 * attached to the combobox input; interactivity stays on that input via
 * `aria-activedescendant`.
 */

type SearchFtsDropdownProps = {
  suggestions: SearchHit[];
  isLoading: boolean;
  isError: boolean;
  activeIndex: number;
  listboxId: string;
  optionId: (index: number) => string;
  onSelectHit: (hit: SearchHit) => void;
};

export function SearchFtsDropdown({
  suggestions,
  isLoading,
  isError,
  activeIndex,
  listboxId,
  optionId,
  onSelectHit,
}: SearchFtsDropdownProps) {
  return (
    <div className="absolute inset-x-2 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
      {isLoading && suggestions.length === 0 ? (
        <div className="flex items-center justify-center py-4">
          <Loader2Icon
            aria-label="Loading suggestions"
            className="size-4 animate-spin text-muted-foreground"
          />
        </div>
      ) : null}

      {!isLoading && isError ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">
          Something went wrong loading suggestions. Try again.
        </p>
      ) : null}

      {!(isLoading || isError) && suggestions.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">No matches</p>
      ) : null}

      {suggestions.length > 0 ? (
        <ul
          aria-label="Search suggestions"
          className="max-h-80 overflow-auto py-1"
          id={listboxId}
          // The owning input carries role="combobox" + aria-controls to this id;
          // interactivity stays on that input via aria-activedescendant, so this
          // ARIA listbox popup is intentional.
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: intentional ARIA combobox listbox popup, see note above.
          role="listbox"
        >
          {suggestions.map((hit, index) => (
            <FtsItem
              hit={hit}
              isActive={index === activeIndex}
              key={`${hit.entityType}:${hit.entityId}`}
              onSelectHit={onSelectHit}
              optionId={optionId(index)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FtsItem({
  hit,
  optionId,
  isActive,
  onSelectHit,
}: Readonly<{
  hit: SearchHit;
  optionId: string;
  isActive: boolean;
  onSelectHit: (hit: SearchHit) => void;
}>) {
  const buildOrgPath = useOrgPath();
  const segments = parseSnippetSegments(hit.snippet);
  const rowClassName = isActive
    ? "flex flex-col gap-1 bg-muted px-3 py-2 focus-visible:outline-none"
    : "flex flex-col gap-1 px-3 py-2 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";
  const body = (
    <>
      <span className="flex items-center gap-2">
        <Chip size="sm" variant="muted">
          {SEARCH_ENTITY_TYPE_LABELS[hit.entityType]}
        </Chip>
        <span className="truncate font-medium text-foreground text-sm">
          {hit.title}
        </span>
      </span>
      <span className="truncate text-muted-foreground text-xs">
        <SnippetHighlight segments={segments} />
      </span>
    </>
  );

  // A hit missing the route fields it needs (a document without its slug/subtype,
  // a project without its team) yields a null route and renders as a plain,
  // non-link row so a click never lands on a 404 — mirrors UnifiedSearchResults
  // and the Enter-to-navigate gate in SearchTypeahead.
  const route = searchHitOrgRelativeRoute(hit);
  const content =
    route === null ? (
      <div className={rowClassName}>{body}</div>
    ) : (
      <Link
        className={rowClassName}
        href={buildOrgPath(route)}
        onClick={() => onSelectHit(hit)}
        tabIndex={-1}
      >
        {body}
      </Link>
    );

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: DOM focus stays on the combobox input; this option is reached via aria-activedescendant, not a tab stop.
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the option role is the required ARIA listbox child; the row's interactivity is the inner Link, focus stays on the combobox input.
    <li aria-selected={isActive} id={optionId} role="option">
      {content}
    </li>
  );
}
