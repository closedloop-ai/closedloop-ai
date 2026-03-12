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
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { useMemo, useState } from "react";
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
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type IssueMetadataPanelProps = {
  issue: IssueWithWorkstream;
  teamIds: string[];
};

export function IssueMetadataPanel({
  issue,
  teamIds,
}: Readonly<IssueMetadataPanelProps>) {
  const updateIssue = useUpdateIssue();
  const { members: teamMembers } = useTeamMembers({ teamIds });

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

  return (
    <MetadataPanel className="self-stretch px-3 pr-4">
      <div className="space-y-6">
        <CollapsibleSection
          onOpenChange={setIsPropertiesOpen}
          open={isPropertiesOpen}
          title="Properties"
        >
          <MetadataSection className="space-y-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                onValueChange={(v) => handleStatusChange(v as IssueStatus)}
                value={issue.status}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_STATUS_OPTIONS.map((statusOption) => (
                    <SelectItem key={statusOption} value={statusOption}>
                      {issueStatusLabels[statusOption] ?? statusOption}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                onValueChange={(v) => handlePriorityChange(v as PriorityType)}
                value={issue.priority}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(Priority).map((priorityOption) => (
                    <SelectItem key={priorityOption} value={priorityOption}>
                      <span className="inline-flex items-center gap-1.5">
                        <PriorityIcon priority={priorityOption} />
                        {issuePriorityLabels[priorityOption] ?? priorityOption}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Assignee</Label>
              <UserSelectPopover
                className="w-full"
                disabled={teamMembers.length === 0}
                onSelect={handleAssigneeChange}
                placeholder="Select assignee..."
                users={teamMembers}
                value={assignee}
              />
            </div>
          </MetadataSection>

          <MetadataSection separator>
            <div className="space-y-1 text-muted-foreground text-sm">
              <p>
                Created:{" "}
                {new Date(issue.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </p>
              <p>
                Updated:{" "}
                {new Date(issue.updatedAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
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
