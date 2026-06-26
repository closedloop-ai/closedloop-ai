"use client";

import { CellTooltip } from "@repo/app/documents/components/table/cells/cell-tooltip";
import {
  CELL_CLASSES,
  CELL_LINK_CLASSES,
} from "@repo/app/documents/components/table/cells/shared-cell-styles";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Link } from "@repo/navigation/link";
import type { MouseEvent } from "react";
import { useContext } from "react";

/**
 * Read-only column cells: Type badge, Parent link, Project link, and Updated
 * timestamp (FEA-1763 / PLN-874 Phase 3; extracted from document-row.tsx).
 */

export function TypeCell({ item }: { item: DocumentRowItem }) {
  const config = getRowTypeConfig(item);
  return (
    <div className={CELL_CLASSES}>
      {config && (
        <Badge className={config.badgeClassName} variant="secondary">
          {config.badgeLabel}
        </Badge>
      )}
    </div>
  );
}

export function ParentCell({ item: _item }: { item: DocumentRowItem }) {
  const { parentTitle, parentHref } = useContext(RowEditContext);

  if (parentTitle && parentHref) {
    return (
      <div className={CELL_LINK_CLASSES}>
        <CellTooltip text={parentTitle}>
          <Link
            className="flex h-full w-full items-center px-3 py-2 hover:bg-muted/50"
            href={parentHref}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
          >
            <span className="truncate font-medium text-muted-foreground text-xs">
              {parentTitle}
            </span>
          </Link>
        </CellTooltip>
      </div>
    );
  }

  return (
    <CellTooltip text={parentTitle}>
      <div className={CELL_CLASSES}>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {parentTitle ?? "—"}
        </span>
      </div>
    </CellTooltip>
  );
}

export function ProjectCell({ item }: { item: DocumentRowItem }) {
  let project: {
    id: string;
    name: string;
    teams?: { id: string; name: string }[];
  } | null = null;

  if (item.kind === "project") {
    project = item.data;
  } else if (item.kind === "document" && item.data.project) {
    project = {
      id: item.data.project.id,
      name: item.data.project.name,
      teams: item.data.project.teams,
    };
  }

  const projectName = project?.name ?? null;
  const teamId = project?.teams?.[0]?.id;
  const projectHref =
    teamId && project?.id ? `/teams/${teamId}/projects/${project.id}` : null;

  if (projectName && projectHref) {
    return (
      <div className={CELL_LINK_CLASSES}>
        <CellTooltip text={projectName}>
          <Link
            className="flex h-full w-full items-center px-3 py-2 hover:bg-muted/50"
            href={projectHref}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
          >
            <span className="truncate font-medium text-muted-foreground text-xs">
              {projectName}
            </span>
          </Link>
        </CellTooltip>
      </div>
    );
  }

  return (
    <CellTooltip text={projectName}>
      <div className={CELL_CLASSES}>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {projectName ?? "—"}
        </span>
      </div>
    </CellTooltip>
  );
}

export function UpdatedCell({ item }: { item: DocumentRowItem }) {
  return (
    <div className={CELL_CLASSES}>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {formatRelativeTime(item.data.updatedAt)}
      </span>
    </div>
  );
}
