"use client";

import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import {
  BoxIcon,
  ChevronDown,
  EllipsisIcon,
  FolderInputIcon,
  InboxIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { CustomFieldCell } from "@/components/custom-fields/custom-field-cell";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import {
  FeatureStatusBadge,
  featureStatusLabels,
} from "@/components/status-badge";
import { useDeleteFeature, useFeatures } from "@/hooks/queries/use-features";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { deriveCustomFieldColumns } from "@/lib/custom-field-utils";

type FeaturesListProps = {
  projectId: string;
  teamId: string;
  onCreateFeature?: () => void;
};

export function FeaturesList({
  projectId,
  teamId,
  onCreateFeature,
}: Readonly<FeaturesListProps>) {
  const { data: features = [], isLoading } = useFeatures({ projectId });
  const deleteFeatureMutation = useDeleteFeature();

  const customFieldColumns = useMemo(
    () => deriveCustomFieldColumns(features),
    [features]
  );

  const handleDelete = (id: string) => {
    return deleteFeatureMutation.mutateAsync(id).then((result) => {
      toast.success("Feature deleted");
      return result.deleted;
    });
  };

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [featureToMove, setFeatureToMove] =
    useState<FeatureWithWorkstream | null>(null);

  const requestMove = (feature: FeatureWithWorkstream) => {
    setFeatureToMove(feature);
    setMoveDialogOpen(true);
  };

  const {
    isOpen: isDeleteOpen,
    itemToDelete,
    isPending: isDeletePending,
    requestDelete,
    confirmDelete,
    setOpen: setDeleteOpen,
  } = useDeleteConfirmation<FeatureWithWorkstream>({
    onDelete: handleDelete,
    getId: (feature) => feature.id,
  });

  const groupedFeatures = useMemo(() => {
    const groups = new Map<FeatureStatus, FeatureWithWorkstream[]>();
    for (const status of STATUS_ORDER) {
      const items = features.filter((f) => f.status === status);
      if (items.length > 0) {
        groups.set(status, items);
      }
    }
    return groups;
  }, [features]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        Loading features...
      </div>
    );
  }

  if (features.length === 0) {
    return (
      <EmptyState
        action={
          onCreateFeature ? (
            <Button onClick={onCreateFeature}>Create Feature</Button>
          ) : undefined
        }
        description="Create a feature to start tracking work for this project."
        icon={InboxIcon}
        title="No features yet"
      />
    );
  }

  return (
    <div className="flex flex-col">
      {STATUS_ORDER.map((status) => {
        const items = groupedFeatures.get(status);
        if (!items) {
          return null;
        }
        return (
          <FeatureStatusSection
            customFieldColumns={customFieldColumns}
            items={items}
            key={status}
            onRequestDelete={requestDelete}
            onRequestMove={requestMove}
            status={status}
          />
        );
      })}

      <DeleteConfirmationDialog
        isPending={isDeletePending}
        itemName={itemToDelete?.title ?? ""}
        onConfirm={confirmDelete}
        onOpenChange={setDeleteOpen}
        open={isDeleteOpen}
        title="Feature"
      />

      {featureToMove && (
        <MoveEntityDialog
          currentProjectId={projectId}
          entity={{
            id: featureToMove.id,
            entityType: EntityType.Feature,
            projectId: featureToMove.projectId,
          }}
          onOpenChange={setMoveDialogOpen}
          open={moveDialogOpen}
          teamId={teamId}
        />
      )}
    </div>
  );
}

type FeatureStatusSectionProps = {
  status: FeatureStatus;
  items: FeatureWithWorkstream[];
  onRequestDelete: (feature: FeatureWithWorkstream) => void;
  onRequestMove: (feature: FeatureWithWorkstream) => void;
  customFieldColumns: CustomFieldValueDetail[];
};

function FeatureStatusSection({
  status,
  items,
  onRequestDelete,
  onRequestMove,
  customFieldColumns,
}: Readonly<FeatureStatusSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex w-full items-center gap-1 border-b bg-muted py-2 pr-1 pl-2.5 text-left">
          <span className="flex flex-1 items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {featureStatusLabels[status]}
            </span>
            <span className="font-medium text-xs leading-4">
              {items.length}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              isOpen ? "" : "-rotate-90"
            }`}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col">
          {items.map((feature) => (
            <FeatureRow
              customFieldColumns={customFieldColumns}
              feature={feature}
              key={feature.id}
              onRequestDelete={onRequestDelete}
              onRequestMove={onRequestMove}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const STATUS_ORDER: FeatureStatus[] = [
  FeatureStatus.Draft,
  FeatureStatus.InProgress,
  FeatureStatus.InReview,
  FeatureStatus.Approved,
  FeatureStatus.Executed,
  FeatureStatus.Done,
  FeatureStatus.Obsolete,
];

type FeatureRowProps = {
  feature: FeatureWithWorkstream;
  onRequestDelete: (feature: FeatureWithWorkstream) => void;
  onRequestMove: (feature: FeatureWithWorkstream) => void;
  customFieldColumns: CustomFieldValueDetail[];
};

function FeatureRow({
  feature,
  onRequestDelete,
  onRequestMove,
  customFieldColumns,
}: Readonly<FeatureRowProps>) {
  return (
    <div className="flex items-center gap-4 border-b bg-background p-1.5">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2.5 px-0 py-0"
        href={`/features/${feature.slug}`}
      >
        <BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        {isDisplayableSlug(feature.slug) && (
          <span className="font-mono text-muted-foreground text-xs">
            {feature.slug}
          </span>
        )}
        <span className="truncate font-medium text-sm">{feature.title}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-2.5">
        {customFieldColumns.map((colDef) => {
          const fieldValue = feature.customFields?.find(
            (f) => f.customFieldId === colDef.customFieldId
          );
          if (!fieldValue) {
            return null;
          }
          return (
            <div key={colDef.customFieldId}>
              <CustomFieldCell value={fieldValue} />
            </div>
          );
        })}
        <PriorityBadge priority={feature.priority} />
        <AssigneeAvatar assignee={feature.assignee} />
        <FeatureStatusBadge status={feature.status} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={(e) => e.stopPropagation()}
              type="button"
            >
              <EllipsisIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onRequestMove(feature)}>
              <FolderInputIcon className="h-4 w-4" />
              Move to Project
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onRequestDelete(feature)}
              variant="destructive"
            >
              <TrashIcon className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
