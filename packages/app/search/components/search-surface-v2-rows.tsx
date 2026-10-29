"use client";

import {
  CommandGroup,
  CommandItem,
} from "@repo/design-system/components/ui/command";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import type { MouseEvent, ReactNode } from "react";
import { parseSnippetSegments } from "../lib/search-display";
import type { SearchSurfaceResult } from "../lib/search-surface-model";
import {
  type SearchSurfaceMode,
  SearchSurfaceModeKind,
} from "./search-surface-v2-props";
import { SnippetHighlight } from "./snippet-highlight";

/**
 * ISS-9414 — the rows, in both shells.
 *
 * One body and one destination resolution, so the ordering, the labels and the
 * href a reader lands on are identical whether the surface is a page or a
 * palette. The mode changes the container and the activation path, never the
 * destination.
 */
export function SearchSurfaceRows({
  mode,
  onActivateResult,
  results,
}: Readonly<{
  mode: SearchSurfaceMode;
  onActivateResult?: (result: SearchSurfaceResult) => void;
  results: readonly SearchSurfaceResult[];
}>) {
  if (mode.kind === SearchSurfaceModeKind.Overlay) {
    return (
      <CommandGroup heading={mode.groupHeading}>
        {results.map((result) => (
          <SearchSurfaceOverlayRow
            key={result.key}
            onActivateResult={onActivateResult}
            result={result}
          />
        ))}
      </CommandGroup>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {results.map((result) => (
        <li key={result.key}>
          <SearchSurfacePageRow
            onActivateResult={onActivateResult}
            result={result}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * A palette row: a `cmdk` option the arrow keys already drive, with a real
 * anchor inside it.
 *
 * ACTIVATION IS WIRED TWICE BECAUSE THERE ARE TWO EVENTS, and they must not
 * both fire for one interaction. cmdk handles Enter by calling `preventDefault`
 * and dispatching a private select event on the OPTION — that event never
 * reaches a descendant anchor, so an `<a href>` alone is not an activation
 * contract here and Enter would dismiss the palette while navigating nowhere.
 * `onSelect` therefore performs the navigation for the keyboard. A mouse click
 * has the opposite problem: the anchor navigates AND the click bubbles to the
 * option, which would navigate a second time, so the anchor stops propagation
 * and lets the link do its own job.
 *
 * The anchor stays out of the tab order either way: a focusable anchor inside a
 * `cmdk` list lets Tab walk the focus ring away from the highlighted option.
 * What it keeps is a REAL href — inspectable, and modifier/middle-clickable.
 */
function SearchSurfaceOverlayRow({
  onActivateResult,
  result,
}: Readonly<{
  onActivateResult?: (result: SearchSurfaceResult) => void;
  result: SearchSurfaceResult;
}>) {
  const { navigate } = useNavigation();
  const href = useRowHref(result);

  const activateFromKeyboard = () => {
    if (href !== null) {
      navigate(href);
    }
    onActivateResult?.(result);
  };

  const activateFromClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Always, so the click cannot also reach the option and navigate twice.
    event.stopPropagation();
    // davetho review: a modified or non-primary click is the browser's to
    // handle — it opens the real href elsewhere and leaves THIS view where it
    // was. Dismissing the palette and clearing the query on it contradicted the
    // row's own promise of modifier/middle-click support. The keyboard path is
    // untouched: `onSelect` carries no modifiers to honour.
    if (isBrowserHandledClick(event)) {
      return;
    }
    onActivateResult?.(result);
  };

  return (
    <CommandItem onSelect={activateFromKeyboard} value={result.key}>
      <SearchSurfaceRowLink dense href={href} onRowClick={activateFromClick}>
        <SearchSurfaceRowBody dense result={result} />
      </SearchSurfaceRowLink>
    </CommandItem>
  );
}

/**
 * The page's row. Split out so it resolves its href through the same
 * {@link useRowHref} the overlay uses and hands it to the link, rather than the
 * link resolving a second time.
 */
function SearchSurfacePageRow({
  onActivateResult,
  result,
}: Readonly<{
  onActivateResult?: (result: SearchSurfaceResult) => void;
  result: SearchSurfaceResult;
}>) {
  const href = useRowHref(result);
  return (
    <SearchSurfaceRowLink
      href={href}
      onRowClick={(event) => {
        if (isBrowserHandledClick(event)) {
          return;
        }
        onActivateResult?.(result);
      }}
    >
      <SearchSurfaceRowBody result={result} />
    </SearchSurfaceRowLink>
  );
}

/**
 * marisolashgrove review: the destination was resolved TWICE for an overlay row —
 * once here for Enter and again inside the link for the anchor — so the file's
 * one-destination-resolution claim was two, and only the anchor was covered by
 * the both-host contract. Both paths now read this one value.
 */
function useRowHref(result: SearchSurfaceResult): string | null {
  const buildOrgPath = useOrgPath();
  return result.destination === null ? null : buildOrgPath(result.destination);
}

/**
 * A click the BROWSER will act on itself — a new tab, a new window, a download —
 * leaving this view untouched. `button !== 0` covers the middle click, which
 * reaches React as a click in the browsers that still dispatch one.
 */
function isBrowserHandledClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

/**
 * The row's destination, resolved once for both modes.
 *
 * A result with no safe route renders as a plain row rather than a dead link —
 * the policy `searchHitOrgRelativeRoute` already applies on Web, kept here so
 * the Desktop overlay inherits it instead of shipping its own answer.
 *
 * `dense` drops the anchor's own padding, hover tint and radius: inside a
 * palette the `cmdk` option already supplies all three, and paying them twice
 * nests two padded boxes with two radii and two backgrounds that can light up
 * at once.
 */
function SearchSurfaceRowLink({
  children,
  dense = false,
  href,
  onRowClick,
}: Readonly<{
  children: ReactNode;
  dense?: boolean;
  /** Already org-scoped by {@link useRowHref}; null renders an unlinked row. */
  href: string | null;
  onRowClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}>) {
  if (href === null) {
    return <div className={dense ? ROW_BASE : ROW_PAGE}>{children}</div>;
  }
  return (
    <Link
      className={dense ? ROW_BASE : ROW_PAGE}
      href={href}
      onClick={onRowClick}
      tabIndex={dense ? -1 : undefined}
    >
      {children}
    </Link>
  );
}

const ROW_BASE = "flex w-full gap-3";
const ROW_PAGE =
  "flex w-full gap-3 rounded-md px-2 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";

/**
 * The kind icon, title, snippet and meta — the whole of what a result SAYS,
 * written once so the both-host contract has one thing to check.
 *
 * `dense` is a palette row, and a palette is a shortlist: it folds the kind and
 * the meta onto the title line and takes the snippet to one `text-xs` line, so
 * the list shows a shortlist rather than three rows. Same text, two lines.
 */
function SearchSurfaceRowBody({
  dense = false,
  result,
}: Readonly<{ dense?: boolean; result: SearchSurfaceResult }>) {
  const Icon = result.icon;
  return (
    <>
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium text-foreground">
            {result.title}
          </span>
          {dense ? <SearchSurfaceRowMeta result={result} /> : null}
        </span>
        {result.snippet.length > 0 ? (
          <p
            className={
              dense
                ? "line-clamp-1 text-muted-foreground text-xs"
                : "line-clamp-2 text-muted-foreground text-sm"
            }
          >
            <SnippetHighlight segments={parseSnippetSegments(result.snippet)} />
          </p>
        ) : null}
        {dense ? null : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <SearchSurfaceRowMeta result={result} />
          </div>
        )}
      </div>
    </>
  );
}

/** The kind, and the trailing fact when the corpus has one. */
function SearchSurfaceRowMeta({
  result,
}: Readonly<{ result: SearchSurfaceResult }>) {
  return (
    <>
      <span className="shrink-0 font-medium text-foreground text-xs">
        {result.kindLabel}
      </span>
      {result.meta === undefined ? null : (
        <span className="shrink-0 text-muted-foreground text-xs">
          {result.meta}
        </span>
      )}
    </>
  );
}
