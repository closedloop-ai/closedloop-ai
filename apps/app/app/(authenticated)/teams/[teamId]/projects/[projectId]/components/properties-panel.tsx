"use client";

import type {
  ProjectPriority,
  ProjectWithDetails,
} from "@repo/api/src/types/organization";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
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
  FlagIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTeamMembers } from "@/hooks/use-team-members";
import { ensureDate } from "@/lib/date-utils";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "@/lib/project-constants";
import { getUserDisplayName } from "@/lib/user-utils";

type PropertiesPanelProps = {
  project: ProjectWithDetails;
  onUpdatePriority?: (priority: ProjectPriority) => void;
  onUpdateOwner?: (ownerId: string | null) => void;
  onUpdateTargetDate?: (date: Date | null) => void;
  onUpdateTeams?: (teamIds: string[]) => void;
};

export function PropertiesPanel({
  project,
  onUpdatePriority,
  onUpdateOwner,
  onUpdateTargetDate,
}: PropertiesPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Fetch members from all teams associated with the project
  const teamIds = useMemo(
    () => project.teams.map((team) => team.id),
    [project.teams]
  );
  const { members: teamMembers } = useTeamMembers({ teamIds });

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
        {/* Priority */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <FlagIcon className="h-4 w-4" />
            <span>Priority</span>
          </div>
          <Select
            onValueChange={(value) =>
              onUpdatePriority?.(value as ProjectPriority)
            }
            value={project.priority}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                <span className={PRIORITY_COLORS[project.priority]}>
                  {PRIORITY_LABELS[project.priority]}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  <span className={PRIORITY_COLORS[value as ProjectPriority]}>
                    {label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Lead/Owner */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <UserIcon className="h-4 w-4" />
            <span>Lead</span>
          </div>
          <UserSelectPopover
            className="w-full"
            onSelect={(user) => onUpdateOwner?.(user?.id || null)}
            placeholder="Assign lead"
            users={teamMembers}
            value={
              project.owner
                ? {
                    id: project.owner.id,
                    name: getUserDisplayName(project.owner),
                    avatarUrl: project.owner.avatarUrl || undefined,
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
      </CollapsibleContent>
    </Collapsible>
  );
}
