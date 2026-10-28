"use client";

import {
  createSessionsListSurfaceV2PreviewRow,
  createSessionsListSurfaceV2PreviewUsage,
  SessionsListSurfaceV2Preview,
} from "@repo/app/agents/components/sessions/sessions-list-surface-v2-demo";
import {
  TableChoiceListCell,
  TableReferenceListCell,
} from "@repo/design-system/components/ui/table-cell-list-primitives";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { type ComponentProps, useEffect, useState } from "react";
import {
  formatAgo,
  formatDuration,
  type SessionRow,
  sessionRows,
} from "../mock";

export function SessionsList({
  onOpenDetail,
}: {
  onOpenDetail: (item: SessionRow) => void;
}) {
  const [navigation] = useState(() =>
    createMemoryNavigation({ initialPath: "/p/sessions" })
  );
  return (
    <NavigationProvider adapter={navigation.adapter}>
      <SessionsListContent onOpenDetail={onOpenDetail} />
    </NavigationProvider>
  );
}

function SessionsListContent({
  onOpenDetail,
}: {
  onOpenDetail: (item: SessionRow) => void;
}) {
  const searchParams = useSearchParamsValue();
  const selectedSessionId = searchParams.get("session");

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    const selectedSession = sessionRowById.get(selectedSessionId);
    if (selectedSession) {
      onOpenDetail(selectedSession);
    }
  }, [onOpenDetail, selectedSessionId]);

  return (
    <SessionsListSurfaceV2Preview
      facetEvidence={previewFacetEvidence}
      initialFavoriteIds={initialFavoriteIds}
      rows={previewRows}
      surfaceProps={{
        className: "min-h-0 flex-1",
        getSessionHref: (row) =>
          sessionRowById.has(row.id)
            ? `/p/sessions?session=${encodeURIComponent(row.id)}`
            : null,
        renderIssues: (row) => {
          const source = sessionRowById.get(row.id);
          return (
            <TableReferenceListCell
              references={(source?.linkedIssues ?? []).map((issue) => ({
                href: issue.url,
                id: issue.slug,
                label: issue.slug,
                tooltip: `${issue.slug}: ${issue.title}`,
              }))}
            />
          );
        },
        renderProjects: (row) => {
          const source = sessionRowById.get(row.id);
          return (
            <TableChoiceListCell
              choices={(source?.projects ?? []).map((project) => ({
                id: project,
                label: project,
              }))}
            />
          );
        },
      }}
      totalRows={PREVIEW_TOTAL_ROWS}
      usage={previewUsage}
    />
  );
}

function toPreviewRow(row: SessionRow) {
  const pullRequests = row.prNumber
    ? [
        {
          label: `#${row.prNumber}`,
          numberLabel: `#${row.prNumber}`,
          statusLabel: row.prState ?? "Unknown",
          title: row.prTitle ?? `Pull request ${row.prNumber}`,
        },
      ]
    : [];
  return createSessionsListSurfaceV2PreviewRow({
    autonomy: row.autonomy,
    branch: row.branch,
    costLabel: `$${row.cost.toFixed(2)}`,
    costValue: row.cost,
    durationLabel: formatDuration(row.durationMs),
    durationMs: row.durationMs,
    harness: row.harness,
    id: row.id,
    lastActivityLabel: formatAgo(row.lastActivityAgoMinutes),
    lastActivityAtMs: PREVIEW_NOW_MS - row.lastActivityAgoMinutes * MINUTE_MS,
    mergeStatusLabel: row.mergeStatusLabel,
    model: row.model,
    name: row.name,
    provenance: row.provenance,
    pullRequests,
    pullRequestSummaryLabel: row.prNumber ? `#${row.prNumber}` : null,
    repo: row.repo,
    startedLabel: formatAgo(row.startedAgoMinutes),
    startedAtMs: PREVIEW_NOW_MS - row.startedAgoMinutes * MINUTE_MS,
    status: row.status,
    updatedLabel: formatAgo(row.updatedAgoMinutes),
    updatedAtMs: PREVIEW_NOW_MS - row.updatedAgoMinutes * MINUTE_MS,
    user: row.user
      ? {
          id: `prototype-user:${row.user.name.toLowerCase().replaceAll(" ", "-")}`,
          name: row.user.name,
        }
      : null,
  });
}

const PREVIEW_TOTAL_ROWS = 1047;
const PREVIEW_NOW_MS = Date.UTC(2026, 7, 26, 12);
const MINUTE_MS = 60_000;
const previewRows = sessionRows.map(toPreviewRow);
const sessionRowById = new Map(sessionRows.map((row) => [row.id, row]));
const previewUsage = createSessionsListSurfaceV2PreviewUsage({
  totalSessions: PREVIEW_TOTAL_ROWS,
});
const initialFavoriteIds = sessionRows
  .filter((row) => row.isFavorite)
  .map((row) => row.id);
const previewFacetEvidence: ComponentProps<
  typeof SessionsListSurfaceV2Preview
>["facetEvidence"] = {
  changeCounts: (row) => {
    const source = sessionRowById.get(row.id);
    return {
      linesAdded: source?.additions,
      linesRemoved: source?.deletions,
    };
  },
};
