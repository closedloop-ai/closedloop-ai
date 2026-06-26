import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { formatCost, formatDuration } from "@repo/app/shared/lib/format-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { lastPathSegment } from "@repo/design-system/components/ui/utils";

/**
 * Repository display label for a session row. Prefers the remote
 * `repositoryFullName` (e.g. `owner/repo`); when a session has no resolved
 * remote (local-only runs), falls back to the last path segment of the
 * working/worktree directory — the repo's folder name — never the raw absolute
 * path. Shared by every Sessions table surface so the column and the Repository
 * filter agree. Returns `null` to render the empty placeholder.
 */
export function resolveSessionRepoLabel(
  item: AgentSessionListItem
): string | null {
  return (
    item.repositoryFullName ?? lastPathSegment(item.cwd ?? item.worktreePath)
  );
}

/**
 * Single mapper from the cloud `AgentSessionListItem` shape to the shared
 * presentational `SessionTableRow`. Consumed by both the web Sessions adapter
 * and the shared `SyncedSessionsTable` so the surfaces never drift.
 *
 * `repo` is the display label resolved by the caller (see
 * `resolveSessionRepoLabel`); pass `null` to render the empty placeholder.
 */
export function agentSessionToSessionTableRow(
  item: AgentSessionListItem,
  repo: string | null
): SessionTableRow {
  const startedAt = toNullableDate(item.startedAt);
  const lastActivityAt = toNullableDate(item.lastActivityAt);

  return {
    autonomy: item.autonomy ?? null,
    costLabel: formatCost(toSafeNumber(item.estimatedCost)),
    durationLabel: formatDuration(
      toNullableDate(item.startedAt),
      toNullableDate(item.endedAt)
    ),
    harness: item.harness,
    id: item.id,
    branch: item.branch ?? null,
    lastActivityLabel: lastActivityAt
      ? formatRelativeTime(lastActivityAt)
      : "—",
    model: item.model,
    name: item.name ?? item.externalSessionId ?? "Unknown session",
    repo,
    startedLabel: startedAt ? formatRelativeTime(startedAt) : "—",
    status: item.status,
    user: item.user
      ? {
          avatarUrl: item.user.avatarUrl,
          name: getUserDisplayName(item.user),
        }
      : null,
  };
}

function toNullableDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toSafeNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
