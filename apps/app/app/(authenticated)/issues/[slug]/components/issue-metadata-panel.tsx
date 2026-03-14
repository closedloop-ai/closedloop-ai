"use client";

import {
  Priority,
  type Priority as PriorityType,
} from "@repo/api/src/types/common";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  ISSUE_STATUS_OPTIONS,
  type IssueStatus,
  type IssueWithWorkstream,
} from "@repo/api/src/types/issue";
import { Label } from "@repo/design-system/components/ui/label";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { useId, useMemo, useState } from "react";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import {
  issuePriorityLabels,
  issueStatusLabels,
} from "@/components/status-badge";
import { useUpdateIssue } from "@/hooks/queries/use-issues";
import { useTeamMembers } from "@/hooks/use-team-members";
import { ISSUE_STATUS_TO_ICON } from "@/lib/project-constants";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type IssueMetadataPanelProps = {
  issue: IssueWithWorkstream;
  teamIds: string[];
  /**
   * "sidebar" = right gutter panel, "bar" = horizontal bar below title, "detailsOnly" = dates + custom fields only
   */
  variant?: "bar" | "detailsOnly" | "sidebar";
};

export function IssueMetadataPanel({
  issue,
  teamIds,
  variant = "sidebar",
}: Readonly<IssueMetadataPanelProps>) {
  const updateIssue = useUpdateIssue();
  const { members: teamMembers } = useTeamMembers({ teamIds });

  const statusId = useId();
  const priorityId = useId();

  const assignee = useMemo(
    () =>
      issue.assignee ? transformApiUserToSelectUser(issue.assignee) : null,
    [issue.assignee]
  );

  const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);

  const handleStatusChange = (status: IssueStatus) => {
    updateIssue.mutate(
      { id: issue.id, status },
      { onSuccess: () => toast.success("Status updated") }
    );
  };

  const handlePriorityChange = (priority: PriorityType) => {
    updateIssue.mutate(
      { id: issue.id, priority },
      { onSuccess: () => toast.success("Priority updated") }
    );
  };

  const handleAssigneeChange = (user: User | null) => {
    updateIssue.mutate(
      { id: issue.id, assigneeId: user?.id ?? null },
      { onSuccess: () => toast.success("Assignee updated") }
    );
  };

  const statusSelectOptions = ISSUE_STATUS_OPTIONS.map((statusOption) => (
    <SelectItem key={statusOption} value={statusOption}>
      <span className="inline-flex items-center gap-1.5">
        <StatusIcon size={16} status={ISSUE_STATUS_TO_ICON[statusOption]} />
        {issueStatusLabels[statusOption] ?? statusOption}
      </span>
    </SelectItem>
  ));

  const prioritySelectOptions = Object.values(Priority).map(
    (priorityOption) => (
      <SelectItem key={priorityOption} value={priorityOption}>
        <span className="inline-flex items-center gap-1.5">
          <PriorityIcon priority={priorityOption} />
          {issuePriorityLabels[priorityOption] ?? priorityOption}
        </span>
      </SelectItem>
    )
  );

  const triggerClassCompact =
    "min-w-0 justify-start gap-1 bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent [&>:last-child]:hidden";
  const triggerClassSidebar =
    "min-w-0 justify-start bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent [&>:last-child]:hidden";

  const assigneePopover = (className: string) => (
    <UserSelectPopover
      className={className}
      disabled={teamMembers.length === 0}
      onSelect={handleAssigneeChange}
      placeholder="Select assignee..."
      users={teamMembers}
      value={assignee}
    />
  );

  if (variant === "bar") {
    return (
      <MetadataPanel variant="bar">
        <MetadataSection layout="horizontal">
          <Select
            onValueChange={(v) => handleStatusChange(v as IssueStatus)}
            value={issue.status}
          >
            <SelectTrigger className={triggerClassCompact} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{statusSelectOptions}</SelectContent>
          </Select>
          <Select
            onValueChange={(v) => handlePriorityChange(v as PriorityType)}
            value={issue.priority}
          >
            <SelectTrigger className={triggerClassCompact} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{prioritySelectOptions}</SelectContent>
          </Select>
          {assigneePopover(
            "w-auto min-w-[7rem] bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
          )}
        </MetadataSection>
      </MetadataPanel>
    );
  }

  const propertiesFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor={statusId}>Status</Label>
        <Select
          onValueChange={(v) => handleStatusChange(v as IssueStatus)}
          value={issue.status}
        >
          <SelectTrigger className={triggerClassSidebar} id={statusId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>{statusSelectOptions}</SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={priorityId}>Priority</Label>
        <Select
          onValueChange={(v) => handlePriorityChange(v as PriorityType)}
          value={issue.priority}
        >
          <SelectTrigger className={triggerClassSidebar} id={priorityId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>{prioritySelectOptions}</SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Assignee</Label>
        {assigneePopover(
          "w-full bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
        )}
      </div>
    </>
  );

  if (variant === "detailsOnly") {
    return (
      <div className="space-y-6">
        <MetadataSection>
          <div className="space-y-1 text-muted-foreground text-sm">
            <p>
              Created:{" "}
              {new Date(issue.createdAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </p>
            <p>
              Updated:{" "}
              {new Date(issue.updatedAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </p>
          </div>
        </MetadataSection>
        <CustomFieldsSection
          entityId={issue.id}
          entityType={CustomFieldEntityType.Issue}
          values={issue.customFields}
        />
      </div>
    );
  }

  return (
    <MetadataPanel className="self-stretch px-3 pr-4">
      <div className="space-y-6">
        <CollapsibleSection
          onOpenChange={setIsPropertiesOpen}
          open={isPropertiesOpen}
          title="Properties"
        >
          <MetadataSection className="space-y-4">
            {propertiesFields}
          </MetadataSection>
          <MetadataSection separator>
            <div className="space-y-1 text-muted-foreground text-sm">
              <p>
                Created:{" "}
                {new Date(issue.createdAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </p>
              <p>
                Updated:{" "}
                {new Date(issue.updatedAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </p>
            </div>
          </MetadataSection>
        </CollapsibleSection>
        <CustomFieldsSection
          entityId={issue.id}
          entityType={CustomFieldEntityType.Issue}
          values={issue.customFields}
        />
      </div>
    </MetadataPanel>
  );
}
