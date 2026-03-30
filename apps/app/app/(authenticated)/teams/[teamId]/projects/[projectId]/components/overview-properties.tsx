"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { getProjectSettings } from "@repo/api/src/types/project";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
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
import { format } from "date-fns";
import {
  ArrowRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useGitHubIntegrationStatus } from "@/hooks/queries/use-github-integration";
import { useTeamMembers } from "@/hooks/use-team-members";
import { ensureDate } from "@/lib/date-utils";
import { PRIORITY_LABELS } from "@/lib/project-constants";
import { getUserDisplayName } from "@/lib/user-utils";
import { DefaultRepositoryPicker } from "./default-repository-picker";

/** Matches SelectTrigger size="sm" styling so all property cells look uniform. */
const selectTriggerClassName =
  "border-input-border bg-input/30 hover:bg-input/50 dark:bg-input/30 dark:hover:bg-input/50 flex h-8 w-full items-center gap-2 rounded-md border px-3 text-sm text-foreground shadow-none transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

type OverviewPropertiesProps = {
  project: ProjectWithDetails;
  onUpdatePriority: (priority: Priority) => void;
  onUpdateAssignee: (assigneeId: string | null) => void;
  onUpdateTargetDate: (date: Date | null) => void;
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function OverviewProperties({
  project,
  onUpdatePriority,
  onUpdateAssignee,
  onUpdateTargetDate,
}: Readonly<OverviewPropertiesProps>) {
  const teamIds = useMemo(
    () => project.teams.map((team) => team.id),
    [project.teams]
  );
  const { members: teamMembers } = useTeamMembers({ teamIds });
  const { data: githubStatus } = useGitHubIntegrationStatus();
  const projectSettings = getProjectSettings(project.settings);
  const targetDate = ensureDate(project.targetDate);
  const isGitHubConnected = githubStatus?.connected === true;

  const assigneeTrigger = (
    <button className={selectTriggerClassName} type="button">
      {project.assignee ? (
        <>
          <Avatar className="h-5 w-5 shrink-0">
            {project.assignee.avatarUrl ? (
              <AvatarImage
                alt={getUserDisplayName(project.assignee)}
                src={project.assignee.avatarUrl}
              />
            ) : null}
            <AvatarFallback className="text-[10px]">
              {getInitials(getUserDisplayName(project.assignee))}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">
            {getUserDisplayName(project.assignee)}
          </span>
        </>
      ) : (
        <>
          <UserIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate text-foreground">Unassigned</span>
        </>
      )}
      <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );

  const dateTrigger = (
    <button className={selectTriggerClassName} type="button">
      <CalendarIcon className="h-4 w-4 shrink-0 text-foreground" />
      {targetDate ? (
        <span className="truncate">{format(targetDate, "MMM d, yyyy")}</span>
      ) : (
        <span className="truncate text-foreground">Set date</span>
      )}
      <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );

  return (
    <div className="space-y-3">
      <h3 className="font-medium text-lg">Properties</h3>
      <div className="flex flex-wrap gap-3">
        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Priority</span>
          <Select
            onValueChange={(value) => onUpdatePriority(value as Priority)}
            value={project.priority}
          >
            <SelectTrigger
              className="w-full text-foreground shadow-none [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg:not([class*='text-'])]:opacity-100"
              size="sm"
            >
              <SelectValue>
                <span className="inline-flex items-center gap-1.5 truncate">
                  <PriorityIcon priority={project.priority} />
                  <span className="truncate">
                    {PRIORITY_LABELS[project.priority]}
                  </span>
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

        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Assignee</span>
          <UserSelectPopover
            onSelect={(user) => onUpdateAssignee(user?.id || null)}
            placeholder="Unassigned"
            trigger={assigneeTrigger}
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

        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Due Date</span>
          <DatePickerPopover
            fromDate={new Date()}
            onSelect={(date) => onUpdateTargetDate(date)}
            placeholder="Set date"
            trigger={dateTrigger}
            value={targetDate}
          />
        </div>

        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Repo</span>
          {isGitHubConnected ? (
            <DefaultRepositoryPicker
              currentSettings={project.settings}
              defaultRepository={projectSettings.defaultRepository}
              projectId={project.id}
            />
          ) : (
            <Button
              asChild
              className="w-full justify-between shadow-none"
              size="sm"
              variant="outline"
            >
              <Link href="/settings?tab=integrations">
                Connect GitHub
                <ArrowRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
