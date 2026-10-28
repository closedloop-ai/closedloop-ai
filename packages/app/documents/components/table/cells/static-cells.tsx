"use client";

import type { ProjectTeamOption } from "@repo/api/src/types/teams";
import { useDocumentCellClasses } from "@repo/app/documents/components/table/cells/cell-frame";
import { CellTooltip } from "@repo/app/documents/components/table/cells/cell-tooltip";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import type { MouseEvent } from "react";
import { useContext } from "react";

/**
 * Read-only column cells: Type label, Parent link, Project link, and Updated
 * timestamp (FEA-1763 / PLN-874 Phase 3; extracted from document-row.tsx).
 */

/**
 * Type column: a plain colored text label, not a filled badge (FEA-3947).
 * Per the design discipline, a filled badge is reserved for genuine status
 * emphasis; type is low-emphasis metadata, so it reads as a plain colored
 * string. The color comes from the row-type registry's `labelClassName`,
 * which derives from the same canonical type-color source the badge used.
 */
export function TypeCell({ item }: { item: DocumentRowItem }) {
  const cells = useDocumentCellClasses();
  const config = getRowTypeConfig(item);
  return (
    <div className={cells.box}>
      {config && (
        <span
          className={cn("truncate font-medium text-xs", config.labelClassName)}
        >
          {config.badgeLabel}
        </span>
      )}
    </div>
  );
}

export function ParentCell({ item: _item }: { item: DocumentRowItem }) {
  const { parentTitle, parentHref } = useContext(RowEditContext);
  const cells = useDocumentCellClasses();

  if (parentTitle && parentHref) {
    return (
      <div className={cells.bareBox}>
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
      <div className={cells.box}>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {parentTitle ?? "—"}
        </span>
      </div>
    </CellTooltip>
  );
}

export function ProjectCell({ item }: { item: DocumentRowItem }) {
  const buildOrgPath = useOrgPath();
  const cells = useDocumentCellClasses();
  let project: {
    id: string;
    name: string;
    teams?: ProjectTeamOption[];
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
    teamId && project?.id
      ? buildOrgPath(`/teams/${teamId}/projects/${project.id}`)
      : null;

  if (projectName && projectHref) {
    return (
      <div className={cells.bareBox}>
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
      <div className={cells.box}>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {projectName ?? "—"}
        </span>
      </div>
    </CellTooltip>
  );
}

export function UpdatedCell({ item }: { item: DocumentRowItem }) {
  const cells = useDocumentCellClasses();
  return (
    <div className={cells.box}>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {formatRelativeTime(item.data.updatedAt)}
      </span>
    </div>
  );
}
