"use client";

import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
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
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  BoxIcon,
  CheckSquareIcon,
  ChevronDown,
  ChevronRight,
  EllipsisIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { CustomFieldCell } from "@/components/custom-fields/custom-field-cell";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { useDeleteDocument, useDocuments } from "@/hooks/queries/use-documents";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { deriveCustomFieldColumns } from "@/lib/custom-field-utils";
import { DOCUMENT_STATUS_TO_ICON } from "@/lib/project-constants";
import type { MyTasksFeatureFilters } from "../types";
import {
  applyClientFilters,
  buildFeatureListParams,
  DISPLAY_GROUPS,
} from "../utils";

type MyTasksListProps = {
  assigneeId: string | null;
  isUserLoading: boolean;
  featureFilters?: MyTasksFeatureFilters;
};

export function MyTasksList({
  assigneeId,
  isUserLoading,
  featureFilters,
}: Readonly<MyTasksListProps>) {
  const listParams = useMemo(
    () => buildFeatureListParams(assigneeId),
    [assigneeId]
  );
  const { data: rawFeatures = [], isLoading } = useDocuments(listParams, {
    enabled: !!assigneeId && !isUserLoading,
  });
  const features = useMemo(
    () =>
      featureFilters
        ? applyClientFilters(rawFeatures, featureFilters)
        : rawFeatures,
    [rawFeatures, featureFilters]
  );
  const deleteFeatureMutation = useDeleteDocument();

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

  const {
    confirmDelete,
    isOpen: isDeleteOpen,
    isPending: isDeletePending,
    itemToDelete,
    requestDelete,
    setOpen: setDeleteOpen,
  } = useDeleteConfirmation<DocumentWithWorkstream>({
    getId: (feature) => feature.id,
    onDelete: handleDelete,
  });

  const grouped = useMemo(() => {
    const map = new Map<string, DocumentWithWorkstream[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = features.filter((i: DocumentWithWorkstream) =>
        group.statuses.includes(i.status)
      );
      if (items.length > 0) {
        map.set(group.key, items);
      }
    }
    return map;
  }, [features]);

  if (isUserLoading || (assigneeId && isLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!assigneeId) {
    return (
      <EmptyState
        description="Sign in to see your assigned tasks."
        icon={CheckSquareIcon}
        title="My Tasks"
      />
    );
  }

  if (features.length === 0) {
    return (
      <EmptyState
        description="Tasks assigned to you will appear here."
        icon={CheckSquareIcon}
        title="No assigned tasks"
      />
    );
  }

  return (
    <div className="flex flex-col">
      {DISPLAY_GROUPS.map((group) => {
        const items = grouped.get(group.key);
        if (!items) {
          return null;
        }
        return (
          <div className="mb-4" key={group.key}>
            <MyTasksStatusSection
              customFieldColumns={customFieldColumns}
              items={items}
              label={group.label}
              onRequestDelete={requestDelete}
            />
          </div>
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
    </div>
  );
}

type MyTasksStatusSectionProps = {
  customFieldColumns: CustomFieldValueDetail[];
  items: DocumentWithWorkstream[];
  label: string;
  onRequestDelete: (feature: DocumentWithWorkstream) => void;
};

function MyTasksStatusSection({
  label,
  items,
  customFieldColumns,
  onRequestDelete,
}: Readonly<MyTasksStatusSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex w-full items-center gap-1 border-b bg-background py-2 pr-1 pl-2.5 text-left">
          <span className="flex flex-1 items-center gap-2">
            <span className="text-muted-foreground text-xs capitalize">
              {label}
            </span>
            <span className="font-medium text-xs leading-4">
              {items.length}
            </span>
            {isOpen ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col">
          {items.map((feature) => (
            <MyTasksRow
              customFieldColumns={customFieldColumns}
              feature={feature}
              key={feature.id}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type MyTasksRowProps = {
  customFieldColumns: CustomFieldValueDetail[];
  feature: DocumentWithWorkstream;
  onRequestDelete: (feature: DocumentWithWorkstream) => void;
};

function MyTasksRow({
  feature,
  customFieldColumns,
  onRequestDelete,
}: Readonly<MyTasksRowProps>) {
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
      <div className="flex shrink-0 items-center gap-4">
        <div className="flex items-center gap-2.5">
          {customFieldColumns.map((colDef) => {
            const fieldValue = feature.customFields?.find(
              (f: CustomFieldValueDetail) =>
                f.customFieldId === colDef.customFieldId
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
        </div>
        <div className="flex items-center gap-1">
          <div className="flex size-8 shrink-0 items-center justify-center">
            <PriorityIcon priority={feature.priority} size={16} />
          </div>
          <div className="flex size-8 shrink-0 items-center justify-center">
            <AssigneeAvatar
              assignee={feature.assignee}
              className="size-5 shrink-0"
            />
          </div>
          <div className="flex size-8 shrink-0 items-center justify-center">
            <StatusIcon
              size={20}
              status={DOCUMENT_STATUS_TO_ICON[feature.status]}
            />
          </div>
        </div>
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
