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
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { buildSettingsPanelRoute } from "@repo/api/src/types/settings-route-links";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { priorityDisplayFallback } from "@repo/app/documents/lib/priority-display-fallback";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { ensureDate } from "@repo/app/shared/lib/date-utils";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import {
  getUserDisplayName,
  getUserInitials,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { useTeamMembers } from "@repo/app/teams/hooks/use-team-members";
import {
  toResolverTeamRepo,
  useTeamRepositoriesUnion,
} from "@repo/app/teams/hooks/use-team-repositories-union";
import { Button } from "@repo/design-system/components/ui/button";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
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
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { format } from "date-fns";
import {
  ArrowRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  GitBranchIcon,
  UserIcon,
} from "lucide-react";
import { useMemo } from "react";
import { RepoOverridePicker } from "./repo-override-picker";

/** Matches SelectTrigger size="sm" styling so all property cells look uniform. */
const selectTriggerClassName = `border-input-border bg-input hover:bg-muted dark:bg-input dark:hover:bg-muted flex h-8 w-full items-center gap-2 rounded-md border px-3 text-sm text-foreground shadow-none transition-[color,box-shadow] ${CHIP_FOCUS_RING_CLASS}`;

type OverviewPropertiesProps = {
  project: ProjectWithDetails;
  onUpdatePriority: (priority: Priority | null) => void;
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
  const priorityOptions = usePriorityOptions();
  // ISS-9441: read here rather than handed in by the page, so this surface's
  // swap sits where the flag is read, and it picks between two whole controls
  // rather than two props on one. Flag OFF keeps the shipped `Select` and the
  // `Medium` an unset priority always displayed as.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const { priority } = unsetPriorityEnabled
    ? project
    : priorityDisplayFallback(project);
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
          <PersonAvatar
            avatarUrl={project.assignee.avatarUrl}
            className="h-5 w-5 shrink-0"
            fallbackClassName="text-[10px]"
            imageAlt={getUserDisplayName(project.assignee)}
            initials={getUserInitials(
              project.assignee.firstName,
              project.assignee.lastName
            )}
            name={getUserDisplayName(project.assignee)}
          />
          <span className="truncate">
            {getUserDisplayName(project.assignee)}
          </span>
        </>
      ) : (
        <>
          <UserIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate text-foreground">
            {UNASSIGNED_ASSIGNEE_LABEL}
          </span>
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
          {unsetPriorityEnabled ? (
            <ArtifactPriorityEditor
              // Radius, hover and focus ring are the caller's by the champion's
              // contract, so the cell keeps the box its three siblings wear.
              className={selectTriggerClassName}
              onSelect={onUpdatePriority}
              priority={priority}
              support={
                ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Project]
              }
              variant={ArtifactPriorityVariant.DetailField}
            />
          ) : (
            <LegacyPrioritySelect
              onUpdatePriority={onUpdatePriority}
              options={priorityOptions}
              priority={priority}
            />
          )}
        </div>

        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Assignee</span>
          <UserSelectPopover
            onSelect={(user) => onUpdateAssignee(user?.id || null)}
            placeholder={UNASSIGNED_ASSIGNEE_LABEL}
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
  const orgPath = useOrgPath();
  if (!isGitHubConnected) {
    return (
      <Button
        asChild
        className="w-full justify-between shadow-none"
        size="sm"
        variant="outline"
      >
        <Link
          href={orgPath(
            buildSettingsPanelRoute({ panel: SettingsPanelId.Profile })
          )}
        >
          {CONNECT_GITHUB_LABEL}
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
    return CONNECT_GITHUB_LABEL;
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

/**
 * ISS-5958 M5: this cell NAVIGATES to Settings rather than owning a connect
 * action, but the words are that action's, so they are read from the one
 * connect copy map instead of being spelled again here.
 */
const CONNECT_GITHUB_LABEL =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel;

/**
 * The control this cell shipped with, kept whole behind the OFF half of
 * {@link ARTIFACT_PRIORITY_UNSET_FLAG_KEY} so nothing about the closed default
 * moves (ISS-4779). It offers the four members and no clear. It goes when the
 * flag does.
 */
function LegacyPrioritySelect({
  onUpdatePriority,
  options,
  priority,
}: Readonly<{
  onUpdatePriority: (priority: Priority | null) => void;
  options: readonly Priority[];
  priority: Priority | null;
}>) {
  return (
    <Select
      onValueChange={(value) => onUpdatePriority(value as Priority)}
      // Radix renders `placeholder` instead of the children for `""`,
      // and `""` (unlike `undefined`) keeps the Select controlled.
      value={priority ?? ""}
    >
      <SelectTrigger
        className="w-full text-foreground shadow-none [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg:not([class*='text-'])]:opacity-100"
        size="sm"
      >
        <SelectValue placeholder={<ProjectPriorityValue priority={null} />}>
          <ProjectPriorityValue priority={priority} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((value) => (
          <SelectItem key={value} value={value}>
            <span className="inline-flex items-center gap-1.5">
              <PriorityIcon priority={value} />
              {PRIORITY_LABELS[value]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The value inside {@link LegacyPrioritySelect}'s trigger.
 *
 * The `null` arm is not a state a viewer reaches: the flag-OFF path folds an
 * unset priority to `Medium` through `priorityDisplayFallback` first. It stays
 * because that helper is generic over `T` and returns `T`, so the field is
 * still typed `Priority | null` here and narrowing it would take a non-null
 * assertion.
 *
 * `PriorityIcon` has no glyph for "no priority", so that arm is the design
 * system's empty-value mark beside the shared label. The mark is hidden from
 * assistive tech: the label already states the value once.
 */
function ProjectPriorityValue({ priority }: { priority: Priority | null }) {
  if (priority === null) {
    return (
      <span className="inline-flex items-center gap-1.5 truncate">
        <span aria-hidden="true">
          <GridEmptyValue />
        </span>
        <span className="truncate">{PRIORITY_LABEL_NONE}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 truncate">
      <PriorityIcon priority={priority} />
      <span className="truncate">{PRIORITY_LABELS[priority]}</span>
    </span>
  );
}
