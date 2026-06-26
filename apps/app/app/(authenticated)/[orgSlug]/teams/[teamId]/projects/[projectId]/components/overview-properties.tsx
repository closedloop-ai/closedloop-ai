"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  ProjectSettings,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import {
  getProjectSettings,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { ensureDate } from "@repo/app/shared/lib/date-utils";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { useTeamMembers } from "@repo/app/teams/hooks/use-team-members";
import {
  toResolverTeamRepo,
  useTeamRepositoriesUnion,
} from "@repo/app/teams/hooks/use-team-repositories-union";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { Link } from "@repo/navigation/link";
import { format } from "date-fns";
import {
  ArrowRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  GitBranchIcon,
  UserIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { RepoOverridePicker } from "./repo-override-picker";

/** Matches SelectTrigger size="sm" styling so all property cells look uniform. */
const selectTriggerClassName =
  "border-input-border bg-input hover:bg-muted dark:bg-input dark:hover:bg-muted flex h-8 w-full items-center gap-2 rounded-md border px-3 text-sm text-foreground shadow-none transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

type OverviewPropertiesProps = {
  project: ProjectWithDetails;
  onUpdatePriority: (priority: Priority) => void;
  onUpdateAssignee: (assigneeId: string | null) => void;
  onUpdateTargetDate: (date: Date | null) => void;
};

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
  const repoSummary = useRepoSummary({
    teamIds,
    settings: projectSettings,
    enabled: isGitHubConnected,
  });

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
              {getUserInitials(
                project.assignee.firstName,
                project.assignee.lastName
              )}
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

        <div className="flex min-w-[175px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Repos</span>
          <RepoCell
            isGitHubConnected={isGitHubConnected}
            project={project}
            projectSettings={projectSettings}
            repoSummary={repoSummary}
            triggerClassName={selectTriggerClassName}
          />
        </div>
      </div>
    </div>
  );
}

type RepoCellProps = {
  isGitHubConnected: boolean;
  project: ProjectWithDetails;
  projectSettings: ProjectSettings;
  repoSummary: string;
  triggerClassName: string;
};

// Splits the Repo cell into two reachable states so OverviewProperties itself
// stays under the cognitive-complexity ceiling: GitHub disconnected (CTA) or
// the repository override popover.
function RepoCell({
  isGitHubConnected,
  project,
  projectSettings,
  repoSummary,
  triggerClassName,
}: RepoCellProps) {
  const orgSlug = useOrgSlug();
  if (!isGitHubConnected) {
    return (
      <Button
        asChild
        className="w-full justify-between shadow-none"
        size="sm"
        variant="outline"
      >
        <Link href={`/${orgSlug}/settings?tab=integrations`}>
          Connect GitHub
          <ArrowRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
      </Button>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={triggerClassName} type="button">
          <GitBranchIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">{repoSummary}</span>
          <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))]">
        <RepoOverridePicker
          currentOverride={projectSettings.repositoryOverrides}
          currentSettings={project.settings}
          projectId={project.id}
          teams={project.teams}
        />
      </PopoverContent>
    </Popover>
  );
}

function useRepoSummary({
  teamIds,
  settings,
  enabled,
}: {
  teamIds: string[];
  settings: ProjectSettings;
  enabled: boolean;
}): string {
  const { repositories, isLoading } = useTeamRepositoriesUnion({
    teamIds,
    enabled,
  });
  if (!enabled) {
    return "Connect GitHub";
  }
  if (isLoading) {
    return "Loading…";
  }
  const resolved = resolveProjectRepoDefaults({
    projectSettings: settings,
    teamRepos: repositories.map(toResolverTeamRepo),
    teamCount: teamIds.length,
  });
  if (!resolved) {
    return "Set defaults";
  }
  const primary = repositories.find(
    (r) => r.installationRepositoryId === resolved.primaryRepoId
  );
  const primaryLabel = primary?.repository.fullName ?? "primary";
  const extras = resolved.selectedRepoIds.length - 1;
  if (extras <= 0) {
    return primaryLabel;
  }
  return `${primaryLabel} +${extras}`;
}
