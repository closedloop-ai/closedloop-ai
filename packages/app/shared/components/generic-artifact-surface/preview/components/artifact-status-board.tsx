// biome-ignore-all lint/a11y/useSemanticElements: Draggable Kanban cards contain nested links and actions.
"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusReadOnlyReasonCopy } from "@repo/app/shared/components/artifact-status/artifact-status-editor";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  Avatar,
  AvatarFallback,
  avatarInitial,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { GridTableV2Group as GridTableGroup } from "@repo/design-system/components/ui/grid-table-v2";
import { KanbanCardFrame } from "@repo/design-system/components/ui/layout/kanban-board";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useState,
} from "react";
import {
  genericArtifactRootFacet,
  genericArtifactStatusCapability,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusKey,
  genericArtifactStatusLabel,
  genericArtifactStatusOptions,
} from "../../generic-artifact-status";
import { GenericArtifactStatusMark } from "../../generic-artifact-status-mark";
import type {
  ArtifactKind,
  ArtifactStatus,
  GenericArtifact,
} from "../fixtures";
import { ArtifactTypeIcons } from "./artifact-icons";
import { resolveArtifactGroupDestination } from "./artifact-list-group-drop";
import type { ArtifactBoardConfig } from "./artifact-list-model";

type ArtifactStatusBoardProps = {
  selectedArtifactIds?: ReadonlySet<string>;
  onSelect?: (
    artifact: GenericArtifact,
    event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>
  ) => void;
  renderField?: (columnId: string, artifact: GenericArtifact) => ReactNode;
  visibleColumnIds?: ReadonlySet<string>;
  canGroupDrop?: (
    artifact: GenericArtifact,
    primaryField: string,
    primaryValue: string,
    secondaryField?: string,
    secondaryValue?: string
  ) => boolean;
  renderTitle?: (artifact: GenericArtifact, href: string) => ReactNode;
  renderStatusMenu?: (artifact: GenericArtifact) => ReactNode;
  defaultKind: ArtifactKind;
  groups: GridTableGroup<GenericArtifact>[];
  groupBy: string;
  secondaryGroupBy: string;
  config: ArtifactBoardConfig;
  noun: { plural: string; singular: string };
  onAdd?: (status: ArtifactStatus) => void;
  onGroupDrop: (
    artifactId: string,
    primaryFieldId: string,
    primaryValue: string,
    secondaryFieldId?: string,
    secondaryValue?: string
  ) => void;
  onOpen: (artifact: GenericArtifact) => void;
  onOpenHref?: (artifact: GenericArtifact) => string | undefined;
  onStatusChange: (
    artifactId: string,
    status: ArtifactStatus,
    surface: ArtifactStatusEditSurface
  ) => void;
};

const WHITESPACE_PATTERN = /\s+/;

function ArtifactBoardCard({
  artifact,
  canDrag,
  config,
  onOpen,
  onOpenHref,
  onDragEndArtifact,
  onDragStartArtifact,
  onStatusChange,
  renderTitle,
  renderStatusMenu,
  showStatus,
  selectedArtifactIds,
  onSelect,
  renderField,
  visibleColumnIds,
  groupBy,
  secondaryGroupBy,
}: Pick<
  ArtifactStatusBoardProps,
  | "config"
  | "onOpen"
  | "onOpenHref"
  | "onStatusChange"
  | "renderTitle"
  | "renderStatusMenu"
  | "selectedArtifactIds"
  | "onSelect"
  | "renderField"
  | "visibleColumnIds"
  | "groupBy"
  | "secondaryGroupBy"
> & {
  artifact: GenericArtifact;
  canDrag: boolean;
  onDragEndArtifact: () => void;
  onDragStartArtifact: (artifactId: string) => void;
  showStatus: boolean;
}) {
  const KindIcon = ArtifactTypeIcons[artifact.kind];
  const href = onOpenHref?.(artifact);
  const capability = genericArtifactStatusCapability(artifact);
  const canEditStatus = config.editable && capability.editable;
  return (
    <KanbanCardFrame
      className={cn(
        "group/card mb-2 min-h-34 cursor-pointer px-3 shadow-none transition-[transform,box-shadow,margin] duration-100 ease-[cubic-bezier(0.05,0.4,0.2,1)] hover:border-foreground/20 hover:bg-muted/30",
        canDrag && "cursor-grab active:cursor-grabbing",
        selectedArtifactIds?.has(artifact.id) &&
          "bg-primary/10 ring-1 ring-primary/20"
      )}
    >
      <div
        draggable={canDrag}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(
              "[data-artifact-board-field],button,a,input,[role=combobox]"
            )
          ) {
            return;
          }
          if (onSelect) {
            onSelect(artifact, event);
          } else {
            onOpen(artifact);
          }
        }}
        onDragEnd={onDragEndArtifact}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/artifact-id", artifact.id);
          event.dataTransfer.effectAllowed = "move";
          onDragStartArtifact(artifact.id);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (onSelect) {
              onSelect(artifact, event);
            } else {
              onOpen(artifact);
            }
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="flex items-start gap-2">
          {groupBy !== "type" && secondaryGroupBy !== "type" ? (
            <KindIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs">{artifact.slug}</div>
            <ArtifactBoardCardTitle
              artifact={artifact}
              href={href}
              renderTitle={renderTitle}
            />
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
              {renderStatusMenu?.(artifact)}
              {!renderStatusMenu && canEditStatus
                ? genericArtifactStatusOptions(artifact.kind).map((status) => (
                    <DropdownMenuItem
                      disabled={
                        genericArtifactStatusKey({
                          kind: artifact.kind,
                          status,
                        }) === genericArtifactStatusKey(artifact)
                      }
                      key={status}
                      onSelect={() =>
                        onStatusChange(
                          artifact.id,
                          status,
                          ArtifactStatusEditSurface.Board
                        )
                      }
                    >
                      Move to{" "}
                      {genericArtifactStatusLabel({
                        kind: artifact.kind,
                        status,
                      })}
                    </DropdownMenuItem>
                  ))
                : null}
              {!(renderStatusMenu || canEditStatus) && (
                <DropdownMenuItem disabled>
                  {capability.editable
                    ? (config.sourceLabel ?? "Status is source-managed")
                    : artifactStatusReadOnlyReasonCopy(capability.reason)}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {showStatus ? (
          <div className="mt-2">
            <GenericArtifactStatusMark artifact={artifact} />
          </div>
        ) : null}
        <ArtifactBoardMetadata
          artifact={artifact}
          groupBy={groupBy}
          renderField={renderField}
          secondaryGroupBy={secondaryGroupBy}
          visibleColumnIds={visibleColumnIds}
        />
      </div>
    </KanbanCardFrame>
  );
}

export function ArtifactStatusBoard({
  selectedArtifactIds,
  onSelect,
  renderField,
  visibleColumnIds,
  renderTitle,
  renderStatusMenu,
  canGroupDrop,
  defaultKind,
  groups,
  groupBy,
  secondaryGroupBy,
  config,
  noun,
  onAdd,
  onGroupDrop,
  onOpen,
  onOpenHref,
  onStatusChange,
}: ArtifactStatusBoardProps) {
  const [dragOverCell, setDragOverCell] = useState<string | null>(null);
  const [draggedArtifactId, setDraggedArtifactId] = useState<string | null>(
    null
  );
  const discoveredSubgroups = new Map(
    groups.flatMap((group) =>
      (group.subgroups ?? []).map((subgroup) => [subgroup.key, subgroup.label])
    )
  );
  const subgroupLabels =
    secondaryGroupBy === "status"
      ? [
          ...new Map(
            groups.flatMap((group) =>
              (group.subgroups ?? []).map((subgroup) => [
                subgroup.key,
                subgroup.label,
              ])
            )
          ),
        ]
      : Array.from(discoveredSubgroups);
  const rows = secondaryGroupBy === "none" ? [["", ""]] : subgroupLabels;
  const statusGroupingActive =
    groupBy === "status" || secondaryGroupBy === "status";
  const artifactsById = new Map(
    groups.flatMap((group) =>
      group.items.map((artifact) => [artifact.id, artifact] as const)
    )
  );
  const canDragArtifact = (artifact: GenericArtifact) =>
    !statusGroupingActive ||
    (config.editable && genericArtifactStatusCapability(artifact).editable);
  const canDropArtifact = (
    artifact: GenericArtifact,
    groupKey: string,
    subgroupKey: string
  ) => {
    if (!canDragArtifact(artifact)) {
      return false;
    }
    if (canGroupDrop) {
      return canGroupDrop(
        artifact,
        groupBy,
        groupKey,
        secondaryGroupBy === "none" ? undefined : secondaryGroupBy,
        secondaryGroupBy === "none" ? undefined : subgroupKey
      );
    }
    return (
      resolveArtifactGroupDestination(
        artifact,
        groupBy,
        groupKey,
        secondaryGroupBy === "none" ? undefined : secondaryGroupBy,
        secondaryGroupBy === "none" ? undefined : subgroupKey
      ) !== null
    );
  };

  const subgroupInitials = (label: string) =>
    label === "Unassigned"
      ? "—"
      : label
          .split(WHITESPACE_PATTERN)
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase();

  const renderCard = (artifact: GenericArtifact) => (
    <ArtifactBoardCard
      artifact={artifact}
      canDrag={canDragArtifact(artifact)}
      config={config}
      groupBy={groupBy}
      key={artifact.id}
      onDragEndArtifact={() => {
        setDraggedArtifactId(null);
        setDragOverCell(null);
      }}
      onDragStartArtifact={setDraggedArtifactId}
      onOpen={onOpen}
      onOpenHref={onOpenHref}
      onSelect={onSelect}
      onStatusChange={onStatusChange}
      renderField={renderField}
      renderStatusMenu={renderStatusMenu}
      renderTitle={renderTitle}
      secondaryGroupBy={secondaryGroupBy}
      selectedArtifactIds={selectedArtifactIds}
      showStatus={groupBy !== "status" && secondaryGroupBy !== "status"}
      visibleColumnIds={visibleColumnIds}
    />
  );
  return (
    <div className="min-h-[360px] overflow-auto px-4 pt-3 pb-6">
      <div
        className="grid min-w-max gap-x-3 gap-y-3"
        style={{
          gridTemplateColumns: `repeat(${groups.length}, minmax(320px, 1fr))`,
        }}
      >
        {groups.map((group) => (
          <div
            className="sticky top-0 z-10 flex min-h-12 items-center gap-2 rounded-md bg-muted px-3 py-2 font-semibold text-sm shadow-[0_1px_0_hsl(var(--border))]"
            key={`header-${group.key}`}
          >
            {groupBy === "status"
              ? (() => {
                  const facet = genericArtifactRootFacet(group.key);
                  return facet ? (
                    <UniversalArtifactStatus
                      facet={facet}
                      variant={ArtifactStatusVariant.BoardLane}
                    />
                  ) : null;
                })()
              : null}
            {groupBy === "status" ? null : <span>{group.label}</span>}
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
                    <AvatarFallback className="text-[10px]">
                      {avatarInitial(subgroupInitials(subgroupLabel))}
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
                  data-status-board-cell={cellKey}
                  key={cellKey}
                  onDragEnter={() => {
                    const artifact = draggedArtifactId
                      ? artifactsById.get(draggedArtifactId)
                      : undefined;
                    if (
                      artifact &&
                      canDropArtifact(artifact, group.key, subgroupKey)
                    ) {
                      setDragOverCell(cellKey);
                    }
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    ) {
                      setDragOverCell(null);
                    }
                  }}
                  onDragOver={(event) => {
                    const artifact = draggedArtifactId
                      ? artifactsById.get(draggedArtifactId)
                      : undefined;
                    if (
                      artifact &&
                      canDropArtifact(artifact, group.key, subgroupKey)
                    ) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOverCell(null);
                    setDraggedArtifactId(null);
                    const artifactId =
                      event.dataTransfer.getData("text/artifact-id");
                    const artifact = artifactsById.get(artifactId);
                    if (
                      !(
                        artifact &&
                        canDropArtifact(artifact, group.key, subgroupKey)
                      )
                    ) {
                      return;
                    }
                    onGroupDrop(
                      artifactId,
                      groupBy,
                      group.key,
                      secondaryGroupBy === "none"
                        ? undefined
                        : secondaryGroupBy,
                      secondaryGroupBy === "none" ? undefined : subgroupKey
                    );
                  }}
                >
                  {items.map((artifact) => renderCard(artifact))}
                  {items.length === 0 ? <div className="h-2" /> : null}
                  {onAdd &&
                  groupBy === "status" &&
                  genericArtifactStatusDefaultForRoot(
                    defaultKind,
                    group.key
                  ) !== null ? (
                    <Button
                      className="mt-1 w-full justify-start text-muted-foreground hover:bg-background/70"
                      onClick={() => {
                        const status = genericArtifactStatusDefaultForRoot(
                          defaultKind,
                          group.key
                        );
                        if (status !== null) {
                          onAdd(status);
                        }
                      }}
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

function ArtifactBoardMetadata({
  artifact,
  renderField,
  visibleColumnIds,
  groupBy,
  secondaryGroupBy,
}: Pick<
  ArtifactStatusBoardProps,
  "renderField" | "visibleColumnIds" | "groupBy" | "secondaryGroupBy"
> & { artifact: GenericArtifact }) {
  return (
    <>
      {" "}
      {renderField ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {["priority", "owner", "collaborators", "tags", "comments", "updated"]
            .filter(
              (field) =>
                visibleColumnIds?.has(field) &&
                field !== groupBy &&
                field !== secondaryGroupBy
            )
            .map((field) => (
              <div data-artifact-board-field="" key={field}>
                {renderField(field, artifact)}
              </div>
            ))}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback className="text-[9px]">
              {avatarInitial(artifact.ownerInitials)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {artifact.owner}
          </span>
          {artifact.commentCount !== undefined && artifact.commentCount > 0 ? (
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <MessageSquareIcon className="size-3" />
              {artifact.commentCount}
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {artifact.updated}
          </span>
        </div>
      )}
    </>
  );
}

function ArtifactBoardCardTitle({
  artifact,
  href,
  renderTitle,
}: {
  artifact: GenericArtifact;
  href?: string;
  renderTitle?: ArtifactStatusBoardProps["renderTitle"];
}) {
  return (
    <>
      {" "}
      {href && renderTitle ? renderTitle(artifact, href) : null}
      {href && !renderTitle ? (
        <a
          className="mt-0.5 block font-medium text-base leading-6 hover:underline"
          href={href}
          onClick={(event) => event.stopPropagation()}
        >
          {artifact.title}
        </a>
      ) : null}
      {!href && (
        <div className="mt-0.5 font-medium text-base leading-6">
          {artifact.title}
        </div>
      )}
    </>
  );
}
