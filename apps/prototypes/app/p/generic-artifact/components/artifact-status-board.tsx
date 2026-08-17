// biome-ignore-all lint/a11y/useSemanticElements: Draggable Kanban cards contain nested links and actions.
"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { KanbanCardFrame } from "@repo/design-system/components/ui/layout/kanban-board";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import type { ArtifactStatus, GenericArtifact } from "../mock";
import { ArtifactTypeIcons } from "./artifact-icons";
import type { ArtifactStatusBoardConfig } from "./artifact-list-model";
import { statusChipClass } from "./artifact-list-model";
import type { GridTableGroup } from "./experimental/grid-table";

type ArtifactStatusBoardProps = {
  groups: GridTableGroup<GenericArtifact>[];
  groupBy: string;
  secondaryGroupBy: string;
  config: ArtifactStatusBoardConfig;
  noun: { plural: string; singular: string };
  onAdd?: (status: ArtifactStatus) => void;
  onGroupChange: (artifactId: string, fieldId: string, value: string) => void;
  onOpen: (artifact: GenericArtifact) => void;
  onOpenHref?: (artifact: GenericArtifact) => string | undefined;
  onStatusChange: (artifactId: string, status: ArtifactStatus) => void;
};

const WHITESPACE_PATTERN = /\s+/;

function ArtifactBoardCard({
  artifact,
  canDrag,
  config,
  onOpen,
  onOpenHref,
  onStatusChange,
}: Pick<
  ArtifactStatusBoardProps,
  "config" | "onOpen" | "onOpenHref" | "onStatusChange"
> & { artifact: GenericArtifact; canDrag: boolean }) {
  const KindIcon = ArtifactTypeIcons[artifact.kind];
  const href = onOpenHref?.(artifact);
  return (
    <KanbanCardFrame
      className={cn(
        "group/card mb-2 cursor-pointer px-3 shadow-none hover:border-foreground/20 hover:bg-muted/30",
        canDrag && "cursor-grab active:cursor-grabbing"
      )}
    >
      <div
        draggable={canDrag}
        onClick={() => onOpen(artifact)}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/artifact-id", artifact.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(artifact);
          }
        }}
        role="link"
        tabIndex={0}
      >
        <div className="flex items-start gap-2">
          <KindIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs">{artifact.slug}</div>
            {href ? (
              <a
                className="mt-0.5 block font-medium text-sm leading-5 hover:underline"
                href={href}
                onClick={(event) => event.stopPropagation()}
              >
                {artifact.title}
              </a>
            ) : (
              <div className="mt-0.5 font-medium text-sm leading-5">
                {artifact.title}
              </div>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`Actions for ${artifact.title}`}
                className="-mr-1 size-7 opacity-0 focus:opacity-100 group-hover/card:opacity-100"
                onClick={(event) => event.stopPropagation()}
                size="icon-sm"
                variant="ghost"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {config.editable ? (
                config.statuses.map((definition) => (
                  <DropdownMenuItem
                    disabled={definition.status === artifact.status}
                    key={definition.status}
                    onSelect={() =>
                      onStatusChange(artifact.id, definition.status)
                    }
                  >
                    Move to {definition.label ?? definition.status}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  {config.sourceLabel ?? "Status is source-managed"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
              {artifact.ownerInitials}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {artifact.owner}
          </span>
          {artifact.commentCount > 0 ? (
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <MessageSquareIcon className="size-3" />
              {artifact.commentCount}
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {artifact.updated}
          </span>
        </div>
      </div>
    </KanbanCardFrame>
  );
}

export function ArtifactStatusBoard({
  groups,
  groupBy,
  secondaryGroupBy,
  config,
  noun,
  onAdd,
  onGroupChange,
  onOpen,
  onOpenHref,
  onStatusChange,
}: ArtifactStatusBoardProps) {
  const [dragOverCell, setDragOverCell] = useState<string | null>(null);
  const discoveredSubgroups = new Map(
    groups.flatMap((group) =>
      (group.subgroups ?? []).map((subgroup) => [subgroup.key, subgroup.label])
    )
  );
  const subgroupLabels =
    secondaryGroupBy === "status"
      ? config.statuses.map((status) => [
          status.status,
          status.label ?? status.status,
        ])
      : Array.from(discoveredSubgroups);
  const rows = secondaryGroupBy === "none" ? [["", ""]] : subgroupLabels;
  const primaryEditable = groupBy !== "status" || config.editable;
  const secondaryEditable =
    secondaryGroupBy === "none" ||
    secondaryGroupBy !== "status" ||
    config.editable;
  const canDrag = primaryEditable && secondaryEditable;

  const subgroupInitials = (label: string) =>
    label === "Unassigned"
      ? "—"
      : label
          .split(WHITESPACE_PATTERN)
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase();

  return (
    <div className="min-h-[360px] overflow-auto px-4 pt-3 pb-6">
      <div
        className="grid min-w-max gap-x-3 gap-y-3"
        style={{
          gridTemplateColumns: `repeat(${groups.length}, minmax(260px, 1fr))`,
        }}
      >
        {groups.map((group) => (
          <div
            className="sticky top-0 z-10 flex min-h-12 items-center gap-2 rounded-md bg-muted px-3 py-2 font-semibold text-sm shadow-[0_1px_0_hsl(var(--border))]"
            key={`header-${group.key}`}
          >
            {groupBy === "status" ? (
              <span
                className={cn(
                  "size-2.5 rounded-full border",
                  statusChipClass[group.key as ArtifactStatus]
                )}
              />
            ) : null}
            <span>{group.label}</span>
            <span className="text-muted-foreground text-xs">
              {group.items.length}
            </span>
          </div>
        ))}

        {rows.flatMap(([subgroupKey, subgroupLabel]) => {
          const rowHeader =
            secondaryGroupBy === "none" ? null : (
              <div
                className="col-span-full flex min-h-10 items-center gap-2 px-2 pt-2 font-semibold text-sm"
                key={`row-${subgroupKey}`}
              >
                <ChevronDownIcon className="size-4 text-muted-foreground" />
                {secondaryGroupBy === "owner" ? (
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-muted text-[10px] text-muted-foreground">
                      {subgroupInitials(subgroupLabel)}
                    </AvatarFallback>
                  </Avatar>
                ) : null}
                <span>{subgroupLabel}</span>
                <span className="text-muted-foreground text-xs">
                  {groups.reduce(
                    (count, group) =>
                      count +
                      (group.subgroups?.find(
                        (subgroup) => subgroup.key === subgroupKey
                      )?.items.length ?? 0),
                    0
                  )}
                </span>
              </div>
            );
          return [
            rowHeader,
            ...groups.map((group) => {
              const items =
                secondaryGroupBy === "none"
                  ? group.items
                  : (group.subgroups?.find(
                      (subgroup) => subgroup.key === subgroupKey
                    )?.items ?? []);
              const cellKey = `${group.key}/${subgroupKey}`;
              return (
                // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Native drag targets are grid cells containing interactive cards, so a button role would be misleading.
                // biome-ignore lint/a11y/noStaticElementInteractions: Native drag targets are grid cells containing interactive cards, so a button role would be misleading.
                <div
                  className={cn(
                    "min-h-44 rounded-md bg-muted/60 p-3 transition-colors",
                    dragOverCell === cellKey &&
                      "bg-primary/10 ring-2 ring-primary/30"
                  )}
                  key={cellKey}
                  onDragEnter={() => canDrag && setDragOverCell(cellKey)}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    ) {
                      setDragOverCell(null);
                    }
                  }}
                  onDragOver={(event) => {
                    if (canDrag) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOverCell(null);
                    const artifactId =
                      event.dataTransfer.getData("text/artifact-id");
                    if (!(artifactId && canDrag)) {
                      return;
                    }
                    onGroupChange(artifactId, groupBy, group.key);
                    if (secondaryGroupBy !== "none") {
                      onGroupChange(artifactId, secondaryGroupBy, subgroupKey);
                    }
                  }}
                >
                  {items.map((artifact) => (
                    <ArtifactBoardCard
                      artifact={artifact}
                      canDrag={canDrag}
                      config={config}
                      key={artifact.id}
                      onOpen={onOpen}
                      onOpenHref={onOpenHref}
                      onStatusChange={onStatusChange}
                    />
                  ))}
                  {items.length === 0 ? <div className="h-2" /> : null}
                  {onAdd && groupBy === "status" ? (
                    <Button
                      className="mt-1 w-full justify-start text-muted-foreground hover:bg-background/70"
                      onClick={() => onAdd(group.key as ArtifactStatus)}
                      size="sm"
                      variant="ghost"
                    >
                      <PlusIcon /> Add {noun.singular}
                    </Button>
                  ) : null}
                </div>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
