"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { AlertTriangleIcon, SearchXIcon } from "lucide-react";
import type { ResultHit, ResultMeta } from "../mock";
import { ENTITY_KIND_LABELS } from "../search-model";
import { KIND_ICONS, SnippetHighlight } from "./kind-visuals";

// One search hit. A single fixed-width kind icon leads the row so the title's
// left edge is identical on every row (a chip's width varies per type and would
// jag that column). The title, the highlighted snippet, then a meta line that
// opens with the type NAME (varying width costs nothing at the bottom) followed
// by Updated and the row's own meta. A hit with no safe route renders as a
// non-link row (no hover affordance) so a click never lands nowhere.
export function ResultRow({ hit }: Readonly<{ hit: ResultHit }>) {
  const Icon = KIND_ICONS[hit.kind];
  const body = (
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
          <SnippetHighlight snippet={hit.snippet} />
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">
            {ENTITY_KIND_LABELS[hit.kind]}
          </span>
          <span>Updated {hit.updated}</span>
          {hit.meta.map((meta) => (
            <span key={`${meta.label ?? ""}${meta.value}`}>
              {metaText(meta)}
            </span>
          ))}
        </div>
      </div>
    </>
  );

  if (hit.unlinked) {
    return (
      <li>
        <div className="flex gap-3 px-2 py-3">{body}</div>
      </li>
    );
  }

  return (
    <li>
      {/* Prototype: a real /search build routes each hit to its entity. Here it
          is a same-page anchor so the row reads as a link (hover, focus ring,
          middle-click) without wiring navigation. */}
      <a
        className="flex gap-3 rounded-md px-2 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        href="#result"
      >
        {body}
      </a>
    </li>
  );
}

export function ResultsBody({
  hits,
}: Readonly<{ hits: readonly ResultHit[] }>) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {hits.map((hit) => (
        <ResultRow hit={hit} key={hit.id} />
      ))}
    </ul>
  );
}

// Loading: skeleton rows matching the result-row rhythm (icon + title + two
// snippet lines + meta) so the layout does not jump when results land.
export function ResultsSkeleton() {
  const rows = [0, 1, 2, 3, 4];
  return (
    <ul aria-hidden="true" className="flex flex-col divide-y divide-border">
      {rows.map((row) => (
        <li className="flex gap-3 px-2 py-3" key={row}>
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-32" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// Load error (non-filter, network/5xx): honest inline message + a retry. Never
// a dead spinner.
export function ResultsLoadError({
  onRetry,
}: Readonly<{ onRetry: () => void }>) {
  return (
    <EmptyState
      action={
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          Try again
        </Button>
      }
      description="Something went wrong loading these results. Your query is fine; this is on our end."
      icon={AlertTriangleIcon}
      title="Couldn't load results"
    />
  );
}

// A meta string: `Label value` where a prefix disambiguates, or the bare value
// where it speaks for itself (`Merged`, `Running`).
function metaText(meta: ResultMeta): string {
  return meta.label ? `${meta.label} ${meta.value}` : meta.value;
}

// No results: echo the query so the user sees what was actually searched, and
// offer to broaden. Not centered muted text.
export function NoResults({
  query,
  onClear,
}: Readonly<{ query: string; onClear: () => void }>) {
  return (
    <EmptyState
      action={
        <Button onClick={onClear} size="sm" type="button" variant="outline">
          Clear query
        </Button>
      }
      description={`Nothing matched ${query.trim().length > 0 ? `“${query.trim()}”` : "your query"}. Try broadening the terms or removing a filter.`}
      icon={SearchXIcon}
      title="No results"
    />
  );
}
