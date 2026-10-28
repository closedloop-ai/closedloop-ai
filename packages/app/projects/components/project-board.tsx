// biome-ignore-all lint/a11y/useSemanticElements: Draggable board cards contain nested project links.
"use client";

import type { ProductGridTableV2SelectionProps } from "@repo/app/shared/components/product-grid-table-v2";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { KanbanCardFrame } from "@repo/design-system/components/ui/layout/kanban-board";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { PINNED_LEAD_TINT_CLASS } from "@repo/design-system/lib/grid-table-pin";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { type ReactNode, useState } from "react";
import {
  type ProjectSummaryRow,
  projectCompletionValue,
} from "../lib/project-summary-row";
import type { ProjectSummaryGroup } from "../lib/project-summary-view";
import { ProjectCompletionIcon, ProjectOwnerAvatar } from "./projects-table";

export type ProjectBoardProps = {
  /** No grouping to drop into: cards stay put rather than offering a no-op. */
  readonly dragDisabled?: boolean;
  readonly getRowHref?: (row: ProjectSummaryRow) => string;
  readonly groupBy: string;
  readonly groups: readonly ProjectSummaryGroup[];
  readonly onGroupDrop: (
    row: ProjectSummaryRow,
    group: ProjectSummaryGroup,
    subgroup?: ProjectSummaryGroup
  ) => void;
  /** Host-owned actions remain reachable in the board layout. */
  readonly rowActions?: (row: ProjectSummaryRow) => ReactNode;
  readonly selection?: Pick<
    ProductGridTableV2SelectionProps<ProjectSummaryRow>,
    "isRowSelected" | "onRowSelectionToggle"
  >;
  readonly secondaryGroupBy: string;
};

export function ProjectBoard({
  dragDisabled = false,
  getRowHref,
  groupBy,
  groups,
  onGroupDrop,
  rowActions,
  selection,
  secondaryGroupBy,
}: ProjectBoardProps) {
  const [dragOverCell, setDragOverCell] = useState<string | null>(null);
  const projects = groups.flatMap((group) => group.items);
  const subgroups = Array.from(
    new Map(
      groups.flatMap((group) =>
        (group.subgroups ?? []).map((subgroup) => [subgroup.key, subgroup])
      )
    ).values()
  );
  const rows = subgroups.length > 0 ? subgroups : [null];

  // ISS-11642: the lane header must hide the cards scrolling under it. The top
  // padding sits on the grid, not the scroll container, because a sticky
  // header pins against the container's padding edge and would leave a strip
  // above it for cards to show in. `--muted` is translucent, so the header
  // paints the same opaque surface the pinned grid column paints
  // (`--grid-table-surface`, falling back to `--background`) and restates the
  // tint on that column's overlay (`PINNED_LEAD_TINT_CLASS`), beneath its
  // content.
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
      <div
        className="grid min-w-max gap-3 pt-3"
        style={{
          gridTemplateColumns: `repeat(${Math.max(groups.length, 1)}, minmax(280px, 1fr))`,
        }}
      >
        {groups.map((group) => (
          <div
            className={cn(
              "sticky top-0 z-10 flex min-h-12 items-center gap-2 rounded-md border-b bg-[var(--grid-table-surface,var(--background))] px-3 py-2 font-semibold text-sm",
              PINNED_LEAD_TINT_CLASS,
              "before:rounded-[inherit] before:bg-muted"
            )}
            key={`header-${group.key}`}
          >
            <span>{group.label}</span>
            <span className="text-muted-foreground text-xs">
              {group.items.length}
            </span>
          </div>
        ))}

        {rows.flatMap((subgroup) => {
          const rowHeader = subgroup ? (
            <div
              className="col-span-full flex min-h-10 items-center gap-2 px-2 pt-2 font-semibold text-sm"
              key={`row-${subgroup.key}`}
            >
              <span>{subgroup.label}</span>
              <span className="text-muted-foreground text-xs">
                {groups.reduce(
                  (count, group) =>
                    count +
                    (group.subgroups?.find(
                      (candidate) => candidate.key === subgroup.key
                    )?.items.length ?? 0),
                  0
                )}
              </span>
            </div>
          ) : null;
          return [
            rowHeader,
            ...groups.map((group) => {
              const items = subgroup
                ? (group.subgroups?.find(
                    (candidate) => candidate.key === subgroup.key
                  )?.items ?? [])
                : group.items;
              const cellKey = `${group.key}/${subgroup?.key ?? "all"}`;
              return (
                // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Board cells are native drop targets containing linked cards.
                // biome-ignore lint/a11y/noStaticElementInteractions: Board cells are native drop targets containing linked cards.
                <div
                  className={cn(
                    "min-h-44 rounded-md bg-muted/60 p-3 transition-colors",
                    dragOverCell === cellKey &&
                      "bg-primary/10 ring-2 ring-primary/30"
                  )}
                  data-project-board-cell={cellKey}
                  key={cellKey}
                  onDragEnter={
                    dragDisabled ? undefined : () => setDragOverCell(cellKey)
                  }
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    ) {
                      setDragOverCell(null);
                    }
                  }}
                  onDragOver={
                    dragDisabled
                      ? undefined
                      : (event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }
                  }
                  onDrop={
                    dragDisabled
                      ? undefined
                      : (event) => {
                          event.preventDefault();
                          setDragOverCell(null);
                          const projectId =
                            event.dataTransfer.getData(PROJECT_DRAG_MIME);
                          const project = projects.find(
                            (candidate) => candidate.id === projectId
                          );
                          if (project) {
                            onGroupDrop(project, group, subgroup ?? undefined);
                          }
                        }
                  }
                >
                  {items.map((project) => (
                    <ProjectBoardCard
                      dragDisabled={dragDisabled}
                      getRowHref={getRowHref}
                      groupBy={groupBy}
                      key={project.id}
                      project={project}
                      rowActions={rowActions}
                      secondaryGroupBy={secondaryGroupBy}
                      selection={selection}
                    />
                  ))}
                </div>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}

export const PROJECT_DRAG_MIME = "text/project-id";

function ProjectBoardCard({
  dragDisabled,
  getRowHref,
  groupBy,
  project,
  rowActions,
  selection,
  secondaryGroupBy,
}: {
  dragDisabled: boolean;
  getRowHref?: (row: ProjectSummaryRow) => string;
  groupBy: string;
  project: ProjectSummaryRow;
  rowActions?: (row: ProjectSummaryRow) => ReactNode;
  selection?: Pick<
    ProductGridTableV2SelectionProps<ProjectSummaryRow>,
    "isRowSelected" | "onRowSelectionToggle"
  >;
  secondaryGroupBy: string;
}) {
  const ownerGrouped = groupBy === "owner" || secondaryGroupBy === "owner";
  const priorityGrouped =
    groupBy === "priority" || secondaryGroupBy === "priority";
  const completion = projectCompletionValue(project);
  const href = getRowHref?.(project);
  const selected = selection?.isRowSelected?.(project) === true;
  const body = (
    <>
      <div className="flex items-start gap-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <ProjectCompletionIcon row={project} />
          <span className="text-muted-foreground text-xs tabular-nums">
            {completion === null ? "—" : `${Math.round(completion)}%`}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-muted-foreground text-xs">
            {project.code ?? "Project"}
          </div>
          <div className="mt-0.5 font-medium text-sm leading-5">
            {project.name}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {ownerGrouped ? null : (
          <>
            {project.owner ? (
              <ProjectOwnerAvatar owner={project.owner} />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
              {project.owner?.name ?? "No owner"}
            </span>
          </>
        )}
        {priorityGrouped ? null : (
          <PriorityIcon priority={project.priority ?? ""} />
        )}
      </div>
    </>
  );

  return (
    <KanbanCardFrame
      className={cn(
        "mb-2 px-3 shadow-none hover:border-foreground/20 hover:bg-background/80",
        selected && "bg-primary/10",
        !dragDisabled && "cursor-grab active:cursor-grabbing"
      )}
    >
      {selection?.onRowSelectionToggle ? (
        <Checkbox
          aria-label={selected ? "Deselect row" : "Select row"}
          checked={selected}
          className="mb-2"
          onCheckedChange={() => selection.onRowSelectionToggle?.(project)}
        />
      ) : null}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: Native drag is attached to the card wrapper while navigation remains a semantic link. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Native drag is attached to the card wrapper while navigation remains a semantic link. */}
      <div
        draggable={!dragDisabled}
        onDragStart={
          dragDisabled
            ? undefined
            : (event) => {
                event.dataTransfer.setData(PROJECT_DRAG_MIME, project.id);
                event.dataTransfer.effectAllowed = "move";
              }
        }
      >
        {href ? (
          <Link className="block" href={href}>
            {body}
          </Link>
        ) : (
          <div className="block">{body}</div>
        )}
      </div>
      {rowActions ? (
        <div className="mt-2 flex justify-end">{rowActions(project)}</div>
      ) : null}
    </KanbanCardFrame>
  );
}
