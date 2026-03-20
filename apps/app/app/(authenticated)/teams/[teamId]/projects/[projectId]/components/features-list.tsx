"use client";

import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { IssueStatus } from "@repo/api/src/types/issue";
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
import { IssueStatusBadge, issueStatusLabels } from "@/components/status-badge";
import { useDeleteIssue, useIssues } from "@/hooks/queries/use-issues";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { deriveCustomFieldColumns } from "@/lib/custom-field-utils";

type FeaturesListProps = {
  projectId: string;
  onCreateFeature?: () => void;
};

export function FeaturesList({
  projectId,
  onCreateFeature,
}: Readonly<FeaturesListProps>) {
  const { data: features = [], isLoading } = useIssues({ projectId });
  const deleteIssueMutation = useDeleteIssue();

  const customFieldColumns = useMemo(
    () => deriveCustomFieldColumns(features),
    [features]
  );

  const handleDelete = (id: string) => {
    return deleteIssueMutation.mutateAsync(id).then((result) => {
      toast.success("Feature deleted");
      return result.deleted;
    });
  };

  const {
    isOpen: isDeleteOpen,
    itemToDelete,
    isPending: isDeletePending,
    requestDelete,
    confirmDelete,
    setOpen: setDeleteOpen,
  } = useDeleteConfirmation<IssueWithWorkstream>({
    onDelete: handleDelete,
    getId: (issue) => issue.id,
  });

  const groupedFeatures = useMemo(() => {
    const groups = new Map<IssueStatus, IssueWithWorkstream[]>();
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
    </div>
  );
}

type FeatureStatusSectionProps = {
  status: IssueStatus;
  items: IssueWithWorkstream[];
  onRequestDelete: (issue: IssueWithWorkstream) => void;
  customFieldColumns: CustomFieldValueDetail[];
};

function FeatureStatusSection({
  status,
  items,
  onRequestDelete,
  customFieldColumns,
}: Readonly<FeatureStatusSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex w-full items-center gap-1 border-b bg-muted py-2 pr-1 pl-2.5 text-left">
          <span className="flex flex-1 items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {issueStatusLabels[status]}
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
          {items.map((issue) => (
            <FeatureRow
              customFieldColumns={customFieldColumns}
              issue={issue}
              key={issue.id}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const STATUS_ORDER: IssueStatus[] = [
  IssueStatus.NotStarted,
  IssueStatus.InProgress,
  IssueStatus.InReview,
  IssueStatus.Completed,
  IssueStatus.Obsolete,
];

type FeatureRowProps = {
  issue: IssueWithWorkstream;
  onRequestDelete: (issue: IssueWithWorkstream) => void;
  customFieldColumns: CustomFieldValueDetail[];
};

function FeatureRow({
  issue,
  onRequestDelete,
  customFieldColumns,
}: Readonly<FeatureRowProps>) {
  return (
    <div className="flex items-center gap-4 border-b bg-background p-1.5">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2.5 px-0 py-0"
        href={`/issues/${issue.slug}`}
      >
        <BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        {isDisplayableSlug(issue.slug) && (
          <span className="font-mono text-muted-foreground text-xs">
            {issue.slug}
          </span>
        )}
        <span className="truncate font-medium text-sm">{issue.title}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-2.5">
        {customFieldColumns.map((colDef) => {
          const fieldValue = issue.customFields?.find(
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
        <PriorityBadge priority={issue.priority} />
        <AssigneeAvatar assignee={issue.assignee} />
        <IssueStatusBadge status={issue.status} />
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
              className="text-destructive focus:text-destructive"
              onClick={() => onRequestDelete(issue)}
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
