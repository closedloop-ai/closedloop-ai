"use client";

import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { sessionStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { resolveArtifactStatusMark } from "@repo/app/shared/lib/artifact-status-appearance";
import {
  formatDateTime,
  formatTimeOfDayOrMonthDay,
} from "@repo/app/shared/lib/date-utils";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import { badgeVariants } from "@repo/design-system/components/ui/badge";
import {
  type TableReference,
  type TableReferenceInteraction,
  TableReferenceListCell,
} from "@repo/design-system/components/ui/table-cell-list-primitives";
import type { TableCellPrimitiveStateProps } from "@repo/design-system/components/ui/table-cell-primitives";

/**
 * Why the cell is empty, on the sentinel's own hover/assistive text.
 *
 * Byte-identical to `RELATED_SESSIONS_EMPTY_TITLE` in
 * `@repo/app/documents/components/related-sessions-cell`, and deliberately not
 * imported from it: the two cells COEXIST rather than supersede each other, and
 * `packages/app/AGENTS.md` forbids `shared/*` from importing a feature slice.
 * That sibling is the artifact-detail FIELD renderer (a Popover disclosure,
 * production-wired through `related-sessions-section.tsx`); this one is the
 * compact single-line GRID renderer that has to survive a measured column
 * width. Neither is a migration target for the other.
 */
export const RELATED_SESSIONS_TABLE_EMPTY_TITLE = "No related sessions";

/**
 * A related session names a destination OR an action, never both: the shared
 * reference chip renders a single interaction arm, so a both-set item would
 * silently lose whichever arm lost the race. The exclusive union is inherited
 * from `TableReference` so the two layers cannot drift apart.
 */
export type RelatedSessionTableItem = {
  id: string;
  sessionSlug: string;
  ownerName: string;
  /**
   * Preferred avatar source. The shared Avatar primitive falls back to
   * ownerInitials when this source is absent or cannot load.
   */
  ownerAvatarUrl?: string;
  status: DisplayedSessionStatus;
  /** Producer-owned lifecycle evidence retained beside the display fold. */
  rawStatus?: string | null;
  relationshipLabel: string;
  /** ISO-8601 timestamp used for the compact calendar-aware label. */
  occurredAt: string;
} & TableReferenceInteraction;

export type RelatedSessionsTableCellProps = TableCellPrimitiveStateProps & {
  items: readonly RelatedSessionTableItem[];
  /** Injectable clock so the today/earlier boundary is deterministic. */
  now?: Date | number;
  /**
   * The server delivers at most `RELATED_SESSIONS_DISPLAY_CAP` items and
   * reports `total` separately; the two differ only by that cap. Passed
   * through as `hiddenReferenceCount` so the overflow pill counts sessions
   * the server withheld, not only the ones this cell measured out.
   *
   * CONTRACT: do not pass `total > 0` with an empty `items`. The primitive
   * returns the empty sentinel before it reads `hiddenReferenceCount`, so the
   * cell would render "No related sessions" over a total that says otherwise.
   * A caller holding that shape (a read that counted rows it could not name)
   * renders its own fallback instead — the Branches adapter renders the count
   * chip carrying `total`.
   *
   * The same derivation lives again on the documents field cell
   * (`packages/app/documents/components/related-sessions-cell.tsx`, `hidden =
   * max(0, total - items.length)`) — a deliberate second copy, for the same
   * reason `RELATED_SESSIONS_TABLE_EMPTY_TITLE` above cites its twin:
   * `packages/app/AGENTS.md` forbids `shared/*` from importing a feature
   * slice.
   */
  total?: number;
};

/**
 * Compact, read-only Related Sessions value for artifact grids.
 *
 * The component owns the session-domain projection: avatar, calendar-aware
 * interaction label, status tone, picture-first owner identity, and the
 * complete accessible sentence. The design-system reference-list primitive
 * continues to own measured fit, avatar-image loading with initials fallback,
 * overflow, empty rendering, and shared grid interaction states.
 */
export function RelatedSessionsTableCell({
  items,
  now,
  total,
  ...stateProps
}: Readonly<RelatedSessionsTableCellProps>) {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const references = champion
    ? items.map((item) => toChampionTableReference(item, now))
    : items.map((item) => toTableReference(item, now));
  const hiddenReferenceCount =
    total === undefined ? 0 : Math.max(0, total - items.length);

  return (
    <TableReferenceListCell
      emptyTitle={RELATED_SESSIONS_TABLE_EMPTY_TITLE}
      hiddenReferenceCount={hiddenReferenceCount}
      references={references}
      {...stateProps}
    />
  );
}

function toChampionTableReference(
  item: RelatedSessionTableItem,
  now?: Date | number
): TableReference {
  const facet = sessionStatusFacet(item.status, item.rawStatus);
  return toTableReference(item, now, {
    className: badgeVariants({
      variant: resolveArtifactStatusMark(facet).tone,
    }),
    statusLabel: artifactStatusLabel(facet),
  });
}

export function toRelatedSessionTableReference(
  item: RelatedSessionTableItem,
  now?: Date | number
): TableReference {
  return toTableReference(item, now);
}

function toTableReference(
  item: RelatedSessionTableItem,
  now?: Date | number,
  presentation?: Readonly<{ className: string; statusLabel: string }>
): TableReference {
  const identity = {
    avatarUrl: item.ownerAvatarUrl,
    className:
      presentation?.className ?? relatedSessionStatusClassName(item.status),
    id: item.id,
    initials: getInitials(item.ownerName),
    label: formatTimeOfDayOrMonthDay(item.occurredAt, { now }),
    tooltip: `${item.sessionSlug} · ${item.ownerName} · ${presentation?.statusLabel ?? SESSION_STATUS_LABELS[item.status]} · ${item.relationshipLabel} · Most recent interaction ${formatDateTime(item.occurredAt)}`,
  };
  if (item.onSelect) {
    return { ...identity, onSelect: item.onSelect };
  }
  return { ...identity, href: item.href };
}

function relatedSessionStatusClassName(status: DisplayedSessionStatus): string {
  if (status === DISPLAYED_SESSION_STATUS.ACTIVE) {
    return "border-success/25 bg-success/10 text-success";
  }
  if (status === DISPLAYED_SESSION_STATUS.ERROR) {
    return "border-destructive/25 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted text-muted-foreground";
}
