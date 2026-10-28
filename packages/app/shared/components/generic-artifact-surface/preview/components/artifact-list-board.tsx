"use client";

import { artifactStatusReadOnlyReasonCopy } from "@repo/app/shared/components/artifact-status/artifact-status-editor";
import {
  ArtifactBoard,
  type ArtifactBoardFeedback,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board";
import type {
  ArtifactBoardFieldDefinition,
  ArtifactBoardItem,
  ArtifactBoardLane,
  ArtifactBoardMove,
  ArtifactBoardMoveTarget,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  ArtifactBoardDropPosition,
  ArtifactBoardMutationState,
  ArtifactBoardSelectionIntent,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { GenericArtifactStatusMark } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status-mark";
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
import { Link } from "@repo/navigation/link";
import { MessageSquareIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  genericArtifactRootFacet,
  genericArtifactStatusCapability,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusKey,
  genericArtifactStatusLabel,
  genericArtifactStatusOptions,
} from "../../generic-artifact-status";
import type {
  ArtifactKind,
  ArtifactStatus,
  GenericArtifact,
} from "../fixtures";
import { ArtifactTypeIcons } from "./artifact-icons";
import { resolveArtifactGroupDestination } from "./artifact-list-group-drop";
import type { ArtifactBoardConfig } from "./artifact-list-model";

const LegacyBoardField = {
  Comments: "comments",
  Owner: "owner",
  Status: "status",
  Updated: "updated",
} as const;

const LEGACY_BOARD_FIELDS = [
  { id: LegacyBoardField.Status, label: "Status", tier: "primary" },
  { id: LegacyBoardField.Owner, label: "Owner", tier: "secondary" },
  { id: LegacyBoardField.Comments, label: "Comments", tier: "secondary" },
  { id: LegacyBoardField.Updated, label: "Updated", tier: "secondary" },
] as const satisfies readonly ArtifactBoardFieldDefinition[];

type ArtifactListBoardViewProps = {
  canGroupDrop?: (
    artifact: GenericArtifact,
    primaryField: string,
    primaryValue: string,
    secondaryField?: string,
    secondaryValue?: string
  ) => boolean;
  config: ArtifactBoardConfig;
  defaultKind: ArtifactKind;
  feedback?: ArtifactBoardFeedback;
  groups: GridTableGroup<GenericArtifact>[];
  groupBy: string;
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
  onSelectionChange?: (
    artifactId: string,
    intent: ArtifactBoardSelectionIntent
  ) => void;
  onStatusChange: (artifactId: string, status: ArtifactStatus) => void;
  renderStatusMenu?: (artifact: GenericArtifact) => ReactNode;
  renderTitle?: (artifact: GenericArtifact, href: string) => ReactNode;
  secondaryGroupBy: string;
  selectedIds?: ReadonlySet<string>;
};

/** Compatibility adapter from the preview shell grouping model to the champion board. */
export function ArtifactListBoardView(props: ArtifactListBoardViewProps) {
  const [localSelectedIds, setLocalSelectedIds] = useState<string[]>([]);
  const model = useMemo(() => legacyBoardModel(props), [props]);
  const selectedIds = props.selectedIds
    ? [...props.selectedIds]
    : localSelectedIds;

  return (
    <ArtifactBoard
      canMoveItem={(item) => canMoveLegacyItem(item, model, props)}
      canMoveItemToTarget={(item, target) => {
        const artifact = model.artifactById.get(item.id);
        const destination = model.laneDestinationById.get(target.laneId);
        return Boolean(
          artifact &&
            destination &&
            legacyDestinationAllowed(artifact, destination, props)
        );
      }}
      feedback={props.feedback ?? { state: ArtifactBoardMutationState.Idle }}
      fields={LEGACY_BOARD_FIELDS}
      getDropTargetLabel={(target) => legacyDropTargetLabel(target, model)}
      items={model.items}
      lanes={model.lanes}
      onMove={(move) => applyLegacyBoardMove(move, model, props)}
      onOpen={(item) => {
        const artifact = model.artifactById.get(item.id);
        if (artifact) {
          props.onOpen(artifact);
        }
      }}
      onSelectionChange={(itemId, intent) => {
        if (props.onSelectionChange) {
          props.onSelectionChange(itemId, intent);
          return;
        }
        setLocalSelectedIds((current) =>
          localBoardSelection(current, itemId, intent)
        );
      }}
      primaryGroupFieldId={props.groupBy}
      renderActions={(item, move) =>
        renderLegacyActions(item, move, model, props)
      }
      renderField={(item, field) =>
        renderLegacyField(item, field, model.artifactById)
      }
      renderTitle={(item, open) =>
        renderLegacyTitle(item, open, model.artifactById, props)
      }
      renderTypeIcon={(item) => {
        const artifact = model.artifactById.get(item.id);
        if (!artifact) {
          return null;
        }
        const Icon = ArtifactTypeIcons[artifact.kind];
        return <Icon className="size-4" />;
      }}
      secondaryGroupFieldId={
        props.secondaryGroupBy === "none" ? null : props.secondaryGroupBy
      }
      selectedIds={selectedIds}
      visibleFieldIds={LEGACY_BOARD_FIELDS.map((field) => field.id)}
    />
  );
}

type LegacyBoardModel = {
  artifactById: ReadonlyMap<string, GenericArtifact>;
  items: ArtifactBoardItem[];
  laneDestinationById: ReadonlyMap<
    string,
    { primaryValue: string; secondaryValue?: string }
  >;
  lanes: ArtifactBoardLane[];
};

function legacyBoardModel(props: ArtifactListBoardViewProps): LegacyBoardModel {
  const artifactById = new Map<string, GenericArtifact>();
  for (const group of props.groups) {
    for (const artifact of group.items) {
      artifactById.set(artifact.id, artifact);
    }
  }
  const laneDestinationById = new Map<
    string,
    { primaryValue: string; secondaryValue?: string }
  >();
  const lanes = legacyBoardLanes(props, artifactById, laneDestinationById);
  const laneIdByArtifact = new Map<string, string>();
  for (const lane of lanes) {
    for (const rootId of lane.rootIds) {
      laneIdByArtifact.set(rootId, lane.id);
    }
  }
  const artifacts = [...artifactById.values()];
  const items = artifacts.map((artifact) => {
    const rootId = legacyRootId(artifact, artifactById);
    return {
      fieldValues: {
        [LegacyBoardField.Comments]: artifact.commentCount ?? null,
        [LegacyBoardField.Owner]: artifact.owner,
        [LegacyBoardField.Status]: artifact.status,
        [LegacyBoardField.Updated]: artifact.updated,
      },
      id: artifact.id,
      laneId: laneIdByArtifact.get(rootId) ?? lanes[0]?.id ?? "ungrouped",
      parentId: artifact.parentArtifactId ?? null,
      rootId,
      slug: artifact.slug,
      title: artifact.title,
      typeLabel: artifact.kind,
    };
  });
  return { artifactById, items, laneDestinationById, lanes };
}

function legacyBoardLanes(
  props: ArtifactListBoardViewProps,
  artifactById: ReadonlyMap<string, GenericArtifact>,
  destinations: Map<string, { primaryValue: string; secondaryValue?: string }>
): ArtifactBoardLane[] {
  const lanes: ArtifactBoardLane[] = [];
  for (const group of props.groups) {
    if (
      props.groupBy === LegacyBoardField.Status &&
      !genericArtifactRootFacet(group.key)
    ) {
      continue;
    }
    const subgroups =
      props.secondaryGroupBy === "none"
        ? [{ key: "", label: "", items: group.items }]
        : (group.subgroups ?? []);
    for (const subgroup of subgroups) {
      const laneId = JSON.stringify([group.key, subgroup.key]);
      destinations.set(laneId, {
        primaryValue: group.key,
        ...(props.secondaryGroupBy === "none"
          ? {}
          : { secondaryValue: subgroup.key }),
      });
      const rootIds = subgroup.items
        .filter(
          (artifact) => legacyRootId(artifact, artifactById) === artifact.id
        )
        .map((artifact) => artifact.id);
      lanes.push({
        header: renderLegacyAdd(props, group.key),
        id: laneId,
        label:
          props.secondaryGroupBy === "none"
            ? group.label
            : `${group.label} · ${subgroup.label}`,
        rootIds,
      });
    }
  }
  return lanes;
}

function renderLegacyAdd(props: ArtifactListBoardViewProps, groupKey: string) {
  const status = genericArtifactStatusDefaultForRoot(
    props.defaultKind,
    groupKey
  );
  if (!(props.onAdd && props.groupBy === "status" && status !== null)) {
    return undefined;
  }
  return (
    <Button
      aria-label={`Add ${props.noun.singular}`}
      onClick={() => props.onAdd?.(status)}
      size="icon-sm"
      variant="ghost"
    >
      <PlusIcon />
    </Button>
  );
}

function legacyRootId(
  artifact: GenericArtifact,
  artifactById: ReadonlyMap<string, GenericArtifact>
) {
  let current = artifact;
  const visited = new Set<string>();
  while (current.parentArtifactId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = artifactById.get(current.parentArtifactId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current.id;
}

function canMoveLegacyItem(
  item: ArtifactBoardItem,
  model: LegacyBoardModel,
  props: ArtifactListBoardViewProps
) {
  const artifact = model.artifactById.get(item.id);
  if (!artifact) {
    return false;
  }
  const statusGrouping =
    props.groupBy === "status" || props.secondaryGroupBy === "status";
  return (
    !statusGrouping ||
    (props.config.editable &&
      genericArtifactStatusCapability(artifact).editable)
  );
}

function applyLegacyBoardMove(
  move: ArtifactBoardMove,
  model: LegacyBoardModel,
  props: ArtifactListBoardViewProps
) {
  const destination = model.laneDestinationById.get(move.target.laneId);
  if (!destination) {
    return;
  }
  for (const artifactId of move.rootIds) {
    const artifact = model.artifactById.get(artifactId);
    if (!(artifact && legacyDestinationAllowed(artifact, destination, props))) {
      continue;
    }
    props.onGroupDrop(
      artifactId,
      props.groupBy,
      destination.primaryValue,
      props.secondaryGroupBy === "none" ? undefined : props.secondaryGroupBy,
      destination.secondaryValue
    );
  }
}

function legacyDestinationAllowed(
  artifact: GenericArtifact,
  destination: { primaryValue: string; secondaryValue?: string },
  props: ArtifactListBoardViewProps
) {
  if (props.canGroupDrop) {
    return props.canGroupDrop(
      artifact,
      props.groupBy,
      destination.primaryValue,
      props.secondaryGroupBy === "none" ? undefined : props.secondaryGroupBy,
      destination.secondaryValue
    );
  }
  return (
    resolveArtifactGroupDestination(
      artifact,
      props.groupBy,
      destination.primaryValue,
      props.secondaryGroupBy === "none" ? undefined : props.secondaryGroupBy,
      destination.secondaryValue
    ) !== null
  );
}

function renderLegacyField(
  item: ArtifactBoardItem,
  field: ArtifactBoardFieldDefinition,
  artifactById: ReadonlyMap<string, GenericArtifact>
) {
  const artifact = artifactById.get(item.id);
  if (!artifact) {
    return null;
  }
  switch (field.id) {
    case LegacyBoardField.Status:
      return <GenericArtifactStatusMark artifact={artifact} />;
    case LegacyBoardField.Owner:
      return (
        <span className="flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback>
              {avatarInitial(artifact.ownerInitials)}
            </AvatarFallback>
          </Avatar>
          <span>{artifact.owner}</span>
        </span>
      );
    case LegacyBoardField.Comments:
      return artifact.commentCount ? (
        <span className="flex items-center gap-1">
          <MessageSquareIcon className="size-3" />
          {artifact.commentCount}
        </span>
      ) : null;
    case LegacyBoardField.Updated:
      return <span>{artifact.updated}</span>;
    default:
      return null;
  }
}

function renderLegacyTitle(
  item: ArtifactBoardItem,
  open: () => void,
  artifactById: ReadonlyMap<string, GenericArtifact>,
  props: ArtifactListBoardViewProps
) {
  const artifact = artifactById.get(item.id);
  if (!artifact) {
    return null;
  }
  const href = props.onOpenHref?.(artifact);
  if (href && props.renderTitle) {
    return props.renderTitle(artifact, href);
  }
  if (href) {
    return (
      <Link className="font-semibold text-base leading-6" href={href}>
        {artifact.title}
      </Link>
    );
  }
  return (
    <Button
      className="h-auto min-h-0 justify-start whitespace-normal p-0 text-left font-semibold text-base leading-6"
      onClick={open}
      variant="link"
    >
      {artifact.title}
    </Button>
  );
}

function renderLegacyActions(
  item: ArtifactBoardItem,
  move: (target: ArtifactBoardMoveTarget) => void,
  model: LegacyBoardModel,
  props: ArtifactListBoardViewProps
) {
  const artifact = model.artifactById.get(item.id);
  if (!artifact) {
    return null;
  }
  const capability = genericArtifactStatusCapability(artifact);
  const canEditStatus = props.config.editable && capability.editable;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Actions for ${artifact.title}`}
          size="icon-sm"
          variant="ghost"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {props.renderStatusMenu?.(artifact)}
        {!props.renderStatusMenu && canEditStatus
          ? genericArtifactStatusOptions(artifact.kind).map((status) => (
              <DropdownMenuItem
                disabled={
                  genericArtifactStatusKey({ kind: artifact.kind, status }) ===
                  genericArtifactStatusKey(artifact)
                }
                key={status}
                onSelect={() => props.onStatusChange(artifact.id, status)}
              >
                Move to{" "}
                {genericArtifactStatusLabel({ kind: artifact.kind, status })}
              </DropdownMenuItem>
            ))
          : null}
        {props.renderStatusMenu || canEditStatus ? null : (
          <DropdownMenuItem disabled>
            {capability.editable
              ? (props.config.sourceLabel ?? "Status is source-managed")
              : artifactStatusReadOnlyReasonCopy(capability.reason)}
          </DropdownMenuItem>
        )}
        {canMoveLegacyItem(item, model, props)
          ? model.lanes.map((lane) => (
              <DropdownMenuItem
                key={lane.id}
                onSelect={() =>
                  move({
                    laneId: lane.id,
                    position: ArtifactBoardDropPosition.End,
                  })
                }
              >
                Move to {lane.label}
              </DropdownMenuItem>
            ))
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function localBoardSelection(
  current: readonly string[],
  itemId: string,
  intent: ArtifactBoardSelectionIntent
) {
  if (intent === ArtifactBoardSelectionIntent.Toggle) {
    return current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId];
  }
  return [itemId];
}

function legacyDropTargetLabel(
  target: ArtifactBoardMoveTarget,
  model: LegacyBoardModel
) {
  const lane = model.lanes.find((candidate) => candidate.id === target.laneId);
  return `Move to ${lane?.label ?? target.laneId}`;
}
