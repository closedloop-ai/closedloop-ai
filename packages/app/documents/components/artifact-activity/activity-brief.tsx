"use client";

import type { DocumentType } from "@repo/api/src/types/document";
import type { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import type { ActivityLinkLookups } from "@repo/app/documents/components/feed-sidebar/sources/activity-formatting";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowRightIcon } from "lucide-react";
import {
  ACTIVITY_BRIEF_EDGE,
  type ActivityBriefItem,
  ActivityBriefItemKind,
  activityBriefFoldLabel,
  foldActivityBrief,
} from "./activity-brief-fold";
import {
  ActivityTimeline,
  type ActivityTimelineRow,
} from "./activity-timeline";

/**
 * ISS-12579 (DI-09): the Activity brief, the short history at the foot of an
 * issue's Artifact tab, under its "Activity summary" heading, below the
 * Branch section (Ottilie, 2026-10-21, ISS-12576). It is not a second
 * Activity tab: it shows how the issue started, one fold for everything in
 * between that opens the Activity tab, and what happened last
 * (`foldActivityBrief`). Rows are the shared `ActivityTimeline` rows, so an
 * event reads the same here and on the Activity tab. It is a bordered group,
 * like the linked work card above it (Nerys, 2026-10-21, ISS-12576).
 */
export function ActivityBrief({
  rows,
  edge = ACTIVITY_BRIEF_EDGE,
  onShowActivity,
  artifactKind,
  documentType,
  links,
  now,
  className,
}: Readonly<{
  /** The issue's history in reading order, oldest first. */
  rows: readonly ActivityTimelineRow[];
  /** Rows kept at each end before the middle folds. */
  edge?: number;
  /** Opens the Activity tab; every fold row calls it. */
  onShowActivity: () => void;
  artifactKind?: ActivityArtifactKind;
  /** The artifact's subtype, for "created this issue" and its statuses. */
  documentType?: DocumentType;
  links?: ActivityLinkLookups;
  /** The clock relative times are measured against (stories pin it). */
  now?: Date | number;
  className?: string;
}>) {
  if (rows.length === 0) {
    return null;
  }
  const groups = groupRuns(foldActivityBrief(rows, edge));
  return (
    <div
      className={cn("flex flex-col rounded-lg border bg-card p-4", className)}
    >
      {groups.map((group) =>
        group.kind === ActivityBriefItemKind.Fold ? (
          <div
            className="flex items-center gap-3 py-2 text-muted-foreground text-sm"
            key={group.item.key}
          >
            <span aria-hidden className="h-px w-4 shrink-0 bg-border" />
            <Button
              className="h-auto min-w-0 justify-start whitespace-normal px-0 py-0.5 text-left text-muted-foreground hover:text-foreground"
              onClick={onShowActivity}
              size="sm"
              type="button"
              variant="link"
            >
              <span className="min-w-0">
                {activityBriefFoldLabel(group.item)}
              </span>
              <ArrowRightIcon aria-hidden="true" className="shrink-0" />
            </Button>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
        ) : (
          <ActivityTimeline
            artifactKind={artifactKind}
            documentType={documentType}
            key={group.key}
            links={links}
            now={now}
            rows={group.rows}
          />
        )
      )}
    </div>
  );
}

type BriefGroup =
  | {
      kind: typeof ActivityBriefItemKind.Fold;
      item: Extract<
        ActivityBriefItem,
        { kind: typeof ActivityBriefItemKind.Fold }
      >;
    }
  | {
      kind: typeof ActivityBriefItemKind.Row;
      key: string;
      rows: ActivityTimelineRow[];
    };

/** Consecutive rows share one timeline list; each fold sits between lists. */
function groupRuns(items: readonly ActivityBriefItem[]): BriefGroup[] {
  const groups: BriefGroup[] = [];
  for (const item of items) {
    if (item.kind === ActivityBriefItemKind.Fold) {
      groups.push({ kind: ActivityBriefItemKind.Fold, item });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === ActivityBriefItemKind.Row) {
      last.rows.push(item.row);
    } else {
      groups.push({
        kind: ActivityBriefItemKind.Row,
        key: `rows-${groups.length}`,
        rows: [item.row],
      });
    }
  }
  return groups;
}
