"use client";

import {
  Priority,
  type Priority as PriorityType,
} from "@repo/api/src/types/common";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  FEATURE_STATUS_OPTIONS,
  type FeatureStatus,
  type FeatureWithWorkstream,
} from "@repo/api/src/types/feature";
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
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import { CollapsibleSection } from "@/components/document-editor/collapsible-section";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/document-editor/metadata-panel";
import {
  featurePriorityLabels,
  featureStatusLabels,
} from "@/components/status-badge";
import { useUpdateFeature } from "@/hooks/queries/use-features";
import { useTeamMembers } from "@/hooks/use-team-members";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type FeatureMetadataPanelProps = {
  feature: FeatureWithWorkstream;
  teamIds: string[];
};

export function FeatureMetadataPanel({
  feature,
  teamIds,
}: Readonly<FeatureMetadataPanelProps>) {
  const updateFeature = useUpdateFeature();
  const { members: teamMembers } = useTeamMembers({ teamIds });

  const assignee = useMemo(
    () =>
      feature.assignee ? transformApiUserToSelectUser(feature.assignee) : null,
    [feature.assignee]
  );

  const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);

  const handleStatusChange = (status: FeatureStatus) => {
    updateFeature.mutate(
      { id: feature.id, status },
      { onSuccess: () => toast.success("Status updated") }
    );
  };

  const handlePriorityChange = (priority: PriorityType) => {
    updateFeature.mutate(
      { id: feature.id, priority },
      { onSuccess: () => toast.success("Priority updated") }
    );
  };

  const handleAssigneeChange = (user: User | null) => {
    updateFeature.mutate(
      { id: feature.id, assigneeId: user?.id ?? null },
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
                onValueChange={(v) => handleStatusChange(v as FeatureStatus)}
                value={feature.status}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEATURE_STATUS_OPTIONS.map((statusOption) => (
                    <SelectItem key={statusOption} value={statusOption}>
                      {featureStatusLabels[statusOption] ?? statusOption}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                onValueChange={(v) => handlePriorityChange(v as PriorityType)}
                value={feature.priority}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(Priority).map((priorityOption) => (
                    <SelectItem key={priorityOption} value={priorityOption}>
                      <span className="inline-flex items-center gap-1.5">
                        <PriorityIcon priority={priorityOption} />
                        {featurePriorityLabels[priorityOption] ??
                          priorityOption}
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
                {new Date(feature.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </p>
              <p>
                Updated:{" "}
                {new Date(feature.updatedAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </p>
            </div>
          </MetadataSection>
        </CollapsibleSection>

        <CustomFieldsSection
          entityId={feature.id}
          entityType={CustomFieldEntityType.Feature}
          values={feature.customFields}
        />
      </div>
    </MetadataPanel>
  );
}
