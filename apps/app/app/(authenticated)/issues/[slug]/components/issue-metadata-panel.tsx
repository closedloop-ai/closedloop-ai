"use client";

import {
  ISSUE_PRIORITY_OPTIONS,
  ISSUE_STATUS_OPTIONS,
  type IssuePriority,
  type IssueStatus,
  type IssueWithWorkstream,
} from "@repo/api/src/types/issue";
import { Label } from "@repo/design-system/components/ui/label";
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
import {
  issuePriorityLabels,
  issueStatusLabels,
} from "@/components/status-badge";
import { useUpdateIssue } from "@/hooks/queries/use-issues";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type IssueMetadataPanelProps = {
  issue: IssueWithWorkstream;
};

export function IssueMetadataPanel({
  issue,
}: Readonly<IssueMetadataPanelProps>) {
  const updateIssue = useUpdateIssue();
  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

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

  const handlePriorityChange = (priority: IssuePriority) => {
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
    <MetadataPanel title="Issue Details">
      <div className="space-y-6">
        <CollapsibleSection
          onOpenChange={setIsPropertiesOpen}
          open={isPropertiesOpen}
          title="Properties"
        >
          <MetadataSection>
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
                onValueChange={(v) => handlePriorityChange(v as IssuePriority)}
                value={issue.priority}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_PRIORITY_OPTIONS.map((priorityOption) => (
                    <SelectItem key={priorityOption} value={priorityOption}>
                      {issuePriorityLabels[priorityOption] ?? priorityOption}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Assignee</Label>
              <UserSelectPopover
                className="w-full"
                disabled={transformedOrgUsers.length === 0}
                onSelect={handleAssigneeChange}
                placeholder="Select assignee..."
                users={transformedOrgUsers}
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
      </div>
    </MetadataPanel>
  );
}
