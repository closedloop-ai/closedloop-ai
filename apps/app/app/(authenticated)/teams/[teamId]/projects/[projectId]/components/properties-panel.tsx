"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  ProjectStatus,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import { getProjectSettings } from "@repo/api/src/types/project";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDotIcon,
  FlagIcon,
  GitBranchIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTeamMembers } from "@/hooks/use-team-members";
import { ensureDate } from "@/lib/date-utils";
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS } from "@/lib/project-constants";
import { getUserDisplayName } from "@/lib/user-utils";
import { CodebaseSummaryUpload } from "./codebase-summary-upload";
import { DefaultRepositoryPicker } from "./default-repository-picker";

type PropertiesPanelProps = {
  project: ProjectWithDetails;
  onUpdatePriority?: (priority: Priority) => void;
  onUpdateStatus?: (status: ProjectStatus) => void;
  onUpdateAssignee?: (assigneeId: string | null) => void;
  onUpdateTargetDate?: (date: Date | null) => void;
  onUpdateTeams?: (teamIds: string[]) => void;
  onCodebaseSummaryUploaded?: (lastIndexedAt: Date) => void;
};

export function PropertiesPanel({
  project,
  onUpdatePriority,
  onUpdateStatus,
  onUpdateAssignee,
  onUpdateTargetDate,
  onCodebaseSummaryUploaded,
}: PropertiesPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Fetch members from all teams associated with the project
  const teamIds = useMemo(
    () => project.teams.map((team) => team.id),
    [project.teams]
  );
  const { members: teamMembers } = useTeamMembers({ teamIds });
  const projectSettings = getProjectSettings(project.settings);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
        <span>Properties</span>
        {isOpen ? (
          <ChevronUpIcon className="h-4 w-4" />
        ) : (
          <ChevronDownIcon className="h-4 w-4" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-3 pb-3">
        {/* Status */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <CircleDotIcon className="h-4 w-4" />
            <span>Status</span>
          </div>
          <Select
            onValueChange={(value) => onUpdateStatus?.(value as ProjectStatus)}
            value={project.status}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{PROJECT_STATUS_LABELS[project.status]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Priority */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <FlagIcon className="h-4 w-4" />
            <span>Priority</span>
          </div>
          <Select
            onValueChange={(value) => onUpdatePriority?.(value as Priority)}
            value={project.priority}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                <span className="inline-flex items-center gap-1.5">
                  <PriorityIcon priority={project.priority} />
                  {PRIORITY_LABELS[project.priority]}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  <span className="inline-flex items-center gap-1.5">
                    <PriorityIcon priority={value as Priority} />
                    {label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Assignee */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <UserIcon className="h-4 w-4" />
            <span>Assignee</span>
          </div>
          <UserSelectPopover
            className="w-full"
            onSelect={(user) => onUpdateAssignee?.(user?.id || null)}
            placeholder="Select assignee"
            users={teamMembers}
            value={
              project.assignee
                ? {
                    id: project.assignee.id,
                    name: getUserDisplayName(project.assignee),
                    avatarUrl: project.assignee.avatarUrl || undefined,
                  }
                : null
            }
          />
        </div>

        {/* Team */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <UsersIcon className="h-4 w-4" />
            <span>Team</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {project.teams.map((team) => (
              <Badge key={team.id} variant="secondary">
                {team.name}
              </Badge>
            ))}
          </div>
        </div>

        {/* Target Date */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <CalendarIcon className="h-4 w-4" />
            <span>Target Date</span>
          </div>
          <DatePickerPopover
            className="w-full"
            fromDate={new Date()}
            onSelect={(date) => onUpdateTargetDate?.(date)}
            placeholder="Set target date"
            value={ensureDate(project.targetDate)}
          />
        </div>

        {/* Default Repository */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <GitBranchIcon className="h-4 w-4" />
            <span>Default Repository</span>
          </div>
          <DefaultRepositoryPicker
            currentSettings={project.settings}
            defaultRepository={projectSettings.defaultRepository}
            projectId={project.id}
          />
        </div>

        {/* Codebase Summary Upload */}
        <div className="pt-2">
          <CodebaseSummaryUpload
            lastIndexedAt={project.lastIndexedAt}
            onUploadSuccess={onCodebaseSummaryUploaded}
            projectId={project.id}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
