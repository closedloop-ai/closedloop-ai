"use client";

import type {
  AgentSessionLastSyncTarget,
  AgentSessionListItem,
  AgentSessionUsageByModel,
  AgentSessionUsageByUser,
} from "@repo/api/src/types/agent-session";
import { ComputeTargetSyncTable } from "@repo/app/compute/components/compute-target-sync-table";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  type DateRange,
  formatCost,
  formatNumber,
  formatTokenCount,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  Clock3Icon,
  FolderGit2Icon,
  HardDriveDownloadIcon,
  InfoIcon,
  MonitorIcon,
  UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
// Projects owns project metadata; org monitoring imports the narrow hook only to label URL-owned filters.
import { useProjects } from "../../../projects/hooks/use-projects";
// Teams owns team metadata; org monitoring imports the narrow hook only to label URL-owned filters.
import { useTeams } from "../../../teams/hooks/use-teams";
import {
  useAgentSessionAnalytics,
  useAgentSessions,
  useAgentSessionUsage,
} from "../../hooks/use-agent-sessions";
import { SESSION_STATUS_FILTER_OPTIONS } from "../../lib/session-status-filters";
import { ModelUsageTable } from "../model-usage-table";
import { SyncedSessionsTable } from "../sessions/synced-sessions-table";
import { DegradedState } from "../shared/degraded-state";
import { MetricSkeleton } from "../shared/metric-skeleton";
import { UserUsageTable } from "../user-usage-table";
import {
  AgentTypeBreakdownTable,
  RepositoryBreakdownTable,
  ToolUsageBreakdownTable,
} from "./analytics-breakdown-tables";
import {
  MobileBreakdownFact,
  MobileBreakdownRow,
} from "./monitoring-breakdown-tables";

const PAGE_SIZE = 25;
const SUMMARY_SKELETON_KEYS = [
  "sessions",
  "input",
  "output",
  "cache",
  "cost",
] as const;
const HARNESS_OPTIONS = ["claude", "codex", "cursor", "copilot", "opencode"];

function renderCostDescription(
  apiEstimatedCost: number,
  subscriptionEstimatedCost: number
): ReactNode {
  if (apiEstimatedCost === 0 && subscriptionEstimatedCost === 0) {
    return "Estimated spend";
  }

  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      API: {formatCost(apiEstimatedCost)} · Sub:{" "}
      {formatCost(subscriptionEstimatedCost)}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <InfoIcon className="inline h-3 w-3 cursor-help" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Estimated cost using API pricing
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

export type AgentTelemetryAnalyticsQueryState = {
  dateRange: DateRange;
  harness: string;
  status: string;
  selectedTeamId: string | null;
  selectedProjectId: string | null;
  selectedUserId: string | null;
  page: number;
};

export type AgentTelemetryAnalyticsProps = {
  exportHref?: string;
  getSessionHref: (item: AgentSessionListItem) => string;
  queryState: AgentTelemetryAnalyticsQueryState;
  onQueryStateChange: (state: AgentTelemetryAnalyticsQueryState) => void;
  analyticsBreakdownsEnabled?: boolean;
  extraColumnLabel?: string;
  renderExtraColumn?: (item: AgentSessionListItem) => ReactNode;
  getUserHref?: (userId: string) => string;
  organizationFiltersEnabled?: boolean;
};

/**
 * Shared portable monitoring body for agent telemetry usage, sessions, and
 * optional org analytics breakdowns. App wrappers own headers, URL mutation,
 * analytics capture, feature flags, and route-specific href construction.
 */
export function AgentTelemetryAnalytics({
  analyticsBreakdownsEnabled = false,
  exportHref,
  extraColumnLabel,
  getSessionHref,
  getUserHref,
  onQueryStateChange,
  organizationFiltersEnabled = false,
  queryState,
  renderExtraColumn,
}: Readonly<AgentTelemetryAnalyticsProps>) {
  const sharedFilters = useMemo(
    () => ({
      harness: queryState.harness === "all" ? undefined : queryState.harness,
      projectId: queryState.selectedProjectId ?? undefined,
      startDate: getStartDateForRange(queryState.dateRange),
      status: queryState.status === "all" ? undefined : queryState.status,
      teamId: queryState.selectedTeamId ?? undefined,
      userId: queryState.selectedUserId ?? undefined,
    }),
    [queryState]
  );
  const usageQuery = useAgentSessionUsage(sharedFilters);
  const analyticsQuery = useAgentSessionAnalytics(sharedFilters, {
    enabled: analyticsBreakdownsEnabled,
  });
  const sessionsQuery = useAgentSessions({
    ...sharedFilters,
    limit: PAGE_SIZE,
    offset: queryState.page * PAGE_SIZE,
  });
  const isAdminViewer =
    organizationFiltersEnabled &&
    usageQuery.data?.viewerScope === "organization";
  const teamsQuery = useTeams({ enabled: isAdminViewer });
  const projectsQuery = useProjects(
    queryState.selectedTeamId ?? undefined,
    { enabled: isAdminViewer },
    undefined
  );
  const hasLoadedSessions = (sessionsQuery.data?.items.length ?? 0) > 0;
  const showEmptyTelemetryState =
    usageQuery.data?.totalSessions === 0 &&
    !hasLoadedSessions &&
    !sessionsQuery.isLoading &&
    !sessionsQuery.isError;
  const totalPages = Math.max(
    1,
    Math.ceil((sessionsQuery.data?.total ?? 0) / PAGE_SIZE)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <MonitoringToolbar
        exportHref={exportHref}
        onQueryStateChange={onQueryStateChange}
        queryState={queryState}
      />
      {isAdminViewer ? (
        <AdminFilters
          onQueryStateChange={onQueryStateChange}
          projects={toMetadataOptions(projectsQuery.data)}
          projectsError={projectsQuery.isError}
          projectsLoading={projectsQuery.isLoading}
          queryState={queryState}
          teams={toMetadataOptions(teamsQuery.data)}
          teamsError={teamsQuery.isError}
          teamsLoading={teamsQuery.isLoading}
          users={usageQuery.data?.byUser ?? []}
        />
      ) : null}
      <SummaryMetrics
        isLoading={usageQuery.isLoading}
        usage={usageQuery.data}
      />
      {usageQuery.isError ? (
        <DegradedState message="Usage metrics are temporarily unavailable." />
      ) : null}
      {showEmptyTelemetryState ? (
        <EmptyTelemetryState />
      ) : (
        <>
          <UsageBreakdown
            getUserHref={getUserHref}
            onSelectUser={(userId) =>
              onQueryStateChange({
                ...queryState,
                page: 0,
                selectedUserId: userId,
              })
            }
            selectedUserId={queryState.selectedUserId}
            usage={usageQuery.data}
          />
          <AnalyticsBreakdowns
            analyticsEnabled={analyticsBreakdownsEnabled}
            analyticsQuery={analyticsQuery}
          />
          <SessionsCard
            extraColumnLabel={extraColumnLabel}
            getSessionHref={getSessionHref}
            isError={sessionsQuery.isError}
            isLoading={sessionsQuery.isLoading}
            items={sessionsQuery.data?.items ?? []}
            onQueryStateChange={onQueryStateChange}
            page={queryState.page}
            queryState={queryState}
            renderExtraColumn={renderExtraColumn}
            totalPages={totalPages}
          />
          <ContextCards targets={usageQuery.data?.lastSyncTargets ?? []} />
        </>
      )}
    </div>
  );
}

function MonitoringToolbar({
  exportHref,
  onQueryStateChange,
  queryState,
}: Readonly<{
  exportHref?: string;
  queryState: AgentTelemetryAnalyticsQueryState;
  onQueryStateChange: (state: AgentTelemetryAnalyticsQueryState) => void;
}>) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">
          Agent Monitoring
        </h1>
        <p className="text-muted-foreground">
          Aggregated agent-session activity across your synced compute targets.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {exportHref ? (
          <Button asChild variant="outline">
            <a href={exportHref}>Export CSV</a>
          </Button>
        ) : null}
        <Select
          onValueChange={(value) =>
            onQueryStateChange({
              ...queryState,
              dateRange: value as DateRange,
              page: 0,
            })
          }
          value={queryState.dateRange}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) =>
            onQueryStateChange({ ...queryState, harness: value, page: 0 })
          }
          value={queryState.harness}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Harness" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All harnesses</SelectItem>
            {HARNESS_OPTIONS.map((harness) => (
              <SelectItem key={harness} value={harness}>
                {harness}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) =>
            onQueryStateChange({ ...queryState, status: value, page: 0 })
          }
          value={queryState.status}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {SESSION_STATUS_FILTER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function AdminFilters({
  onQueryStateChange,
  projects,
  projectsError,
  projectsLoading,
  queryState,
  teams,
  teamsError,
  teamsLoading,
  users,
}: Readonly<{
  queryState: AgentTelemetryAnalyticsQueryState;
  onQueryStateChange: (state: AgentTelemetryAnalyticsQueryState) => void;
  teams: Array<{ id: string; name: string }>;
  teamsLoading: boolean;
  teamsError: boolean;
  projects: Array<{ id: string; name: string }>;
  projectsLoading: boolean;
  projectsError: boolean;
  users: AgentSessionUsageByUser[];
}>) {
  const teamOptions = withSelectedFallbackOption(
    teams,
    queryState.selectedTeamId,
    "Selected team"
  );
  const projectOptions = withSelectedFallbackOption(
    projects,
    queryState.selectedProjectId,
    "Selected project"
  );

  return (
    <div className="space-y-2">
      <div className="grid gap-3 md:grid-cols-3">
        <Select
          onValueChange={(value) =>
            onQueryStateChange({
              ...queryState,
              page: 0,
              selectedProjectId: null,
              selectedTeamId: value === "all" ? null : value,
            })
          }
          value={queryState.selectedTeamId ?? "all"}
        >
          <SelectTrigger>
            <SelectValue placeholder="Filter by team" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teamOptions.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) =>
            onQueryStateChange({
              ...queryState,
              page: 0,
              selectedProjectId: value === "all" ? null : value,
            })
          }
          value={queryState.selectedProjectId ?? "all"}
        >
          <SelectTrigger>
            <SelectValue placeholder="Filter by project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projectOptions.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) =>
            onQueryStateChange({
              ...queryState,
              page: 0,
              selectedUserId: value === "all" ? null : value,
            })
          }
          value={queryState.selectedUserId ?? "all"}
        >
          <SelectTrigger>
            <SelectValue placeholder="Filter by user" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            {users.map((user) => (
              <SelectItem key={user.userId} value={user.userId}>
                {formatUserName(user)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <MetadataAvailabilityNotice
        isError={teamsError}
        isLoading={teamsLoading}
        kind="team"
        selectedId={queryState.selectedTeamId}
      />
      <MetadataAvailabilityNotice
        isError={projectsError}
        isLoading={projectsLoading}
        kind="project"
        selectedId={queryState.selectedProjectId}
      />
    </div>
  );
}

function SummaryMetrics({
  isLoading,
  usage,
}: Readonly<{
  isLoading: boolean;
  usage?: {
    apiEstimatedCost: number;
    subscriptionEstimatedCost: number;
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalEstimatedCost: number;
  };
}>) {
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {SUMMARY_SKELETON_KEYS.map((key) => (
          <MetricSkeleton key={key} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <MetricCard
        detail="Sessions matched by the current filters"
        label="Sessions"
        value={formatNumber(usage?.totalSessions ?? 0)}
      />
      <MetricCard
        detail="Input tokens"
        label="Input"
        value={formatTokenCount(usage?.totalInputTokens ?? 0)}
      />
      <MetricCard
        detail="Output tokens"
        label="Output"
        value={formatTokenCount(usage?.totalOutputTokens ?? 0)}
      />
      <MetricCard
        detail="Read + write cache tokens"
        label="Cache"
        value={formatTokenCount(
          (usage?.totalCacheReadTokens ?? 0) +
            (usage?.totalCacheWriteTokens ?? 0)
        )}
      />
      <MetricCard
        detail={renderCostDescription(
          usage?.apiEstimatedCost ?? 0,
          usage?.subscriptionEstimatedCost ?? 0
        )}
        label="Cost"
        value={formatCost(usage?.totalEstimatedCost ?? 0)}
      />
    </div>
  );
}

function UsageBreakdown({
  getUserHref,
  onSelectUser,
  selectedUserId,
  usage,
}: Readonly<{
  usage:
    | {
        byUser: AgentSessionUsageByUser[];
        byModel: AgentSessionUsageByModel[];
      }
    | undefined;
  selectedUserId: string | null;
  onSelectUser: (userId: string | null) => void;
  getUserHref?: (userId: string) => string;
}>) {
  const userRows = (usage?.byUser ?? []).map((row) => ({
    active: selectedUserId === row.userId,
    cost: formatCost(row.estimatedCost),
    href: getUserHref?.(row.userId),
    id: row.userId,
    input: formatTokenCount(row.inputTokens),
    label: formatUserName(row),
    output: formatTokenCount(row.outputTokens),
    sessions: formatNumber(row.sessionCount),
  }));
  const modelRows = (usage?.byModel ?? []).map((row) => ({
    cache: formatTokenCount(row.cacheReadTokens + row.cacheWriteTokens),
    cost: formatCost(row.estimatedCost),
    input: formatTokenCount(row.inputTokens),
    model: row.model,
    output: formatTokenCount(row.outputTokens),
    sessions: formatNumber(row.sessionCount),
  }));

  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserIcon className="h-4 w-4" />
            User Breakdown
          </CardTitle>
          <CardDescription>
            Click a user to filter the sessions table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="cl-mobile-only space-y-3">
            {userRows.map((row) => (
              <MobileUserAnalyticsRow
                active={row.active}
                key={row.id}
                onSelect={() =>
                  onSelectUser(selectedUserId === row.id ? null : row.id)
                }
                row={row}
              />
            ))}
          </div>
          <div className="cl-desktop-block">
            <UserUsageTable
              onToggleUser={(userId) =>
                onSelectUser(selectedUserId === userId ? null : userId)
              }
              rows={userRows}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BotIcon className="h-4 w-4" />
            Model Breakdown
          </CardTitle>
          <CardDescription>Token usage and cost by model.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="cl-mobile-only space-y-3">
            {modelRows.map((row) => (
              <MobileBreakdownRow key={row.model} title={row.model}>
                <MobileBreakdownFact label="Sessions" value={row.sessions} />
                <MobileBreakdownFact label="Input" value={row.input} />
                <MobileBreakdownFact label="Output" value={row.output} />
                <MobileBreakdownFact label="Cache" value={row.cache} />
                <MobileBreakdownFact label="Cost" value={row.cost} />
              </MobileBreakdownRow>
            ))}
          </div>
          <div className="cl-desktop-block">
            <ModelUsageTable rows={modelRows} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MobileUserAnalyticsRow({
  active = false,
  onSelect,
  row,
}: Readonly<{
  active?: boolean;
  onSelect: () => void;
  row: {
    cost: string;
    input: string;
    label: string;
    output: string;
    sessions: string;
  };
}>) {
  return (
    <button
      aria-label={`Filter sessions by ${row.label}`}
      aria-pressed={active}
      className={cn(
        "w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-primary bg-primary/5"
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="break-words font-medium">{row.label}</span>
        {active ? (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs">
            Filtered
          </span>
        ) : null}
      </div>
      <div className="space-y-2 text-sm">
        <MobileButtonAnalyticsFact label="Sessions" value={row.sessions} />
        <MobileButtonAnalyticsFact label="Input" value={row.input} />
        <MobileButtonAnalyticsFact label="Output" value={row.output} />
        <MobileButtonAnalyticsFact label="Cost" value={row.cost} />
      </div>
    </button>
  );
}

function MobileButtonAnalyticsFact({
  label,
  value,
}: Readonly<{
  label: string;
  value: ReactNode;
}>) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function AnalyticsBreakdowns({
  analyticsEnabled,
  analyticsQuery,
}: Readonly<{
  analyticsEnabled: boolean;
  analyticsQuery: ReturnType<typeof useAgentSessionAnalytics>;
}>) {
  if (!analyticsEnabled) {
    return null;
  }
  if (analyticsQuery.isLoading) {
    return <Skeleton className="h-[240px] w-full" />;
  }
  if (analyticsQuery.isError) {
    return (
      <DegradedState message="Analytics breakdowns are temporarily unavailable." />
    );
  }
  if (!analyticsQuery.data) {
    return null;
  }

  return (
    <>
      <Separator />
      <div className="grid gap-6 xl:grid-cols-2">
        <ToolUsageBreakdownTable data={analyticsQuery.data.byTool} />
        <AgentTypeBreakdownTable data={analyticsQuery.data.byAgentType} />
      </div>
      <RepositoryBreakdownTable
        projects={analyticsQuery.data.byProject}
        repositories={analyticsQuery.data.byRepository}
      />
    </>
  );
}

function SessionsCard({
  extraColumnLabel,
  getSessionHref,
  isError,
  isLoading,
  items,
  onQueryStateChange,
  page,
  queryState,
  renderExtraColumn,
  totalPages,
}: Readonly<{
  items: AgentSessionListItem[];
  isLoading: boolean;
  isError: boolean;
  getSessionHref: (item: AgentSessionListItem) => string;
  page: number;
  totalPages: number;
  queryState: AgentTelemetryAnalyticsQueryState;
  onQueryStateChange: (state: AgentTelemetryAnalyticsQueryState) => void;
  extraColumnLabel?: string;
  renderExtraColumn?: (item: AgentSessionListItem) => ReactNode;
}>) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ActivityIcon className="h-4 w-4" />
              Sessions
            </CardTitle>
            <CardDescription>
              Recent synced sessions with full detail pages.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={page === 0}
              onClick={() =>
                onQueryStateChange({
                  ...queryState,
                  page: Math.max(0, page - 1),
                })
              }
              variant="outline"
            >
              Previous
            </Button>
            <span className="text-muted-foreground text-sm">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              disabled={page + 1 >= totalPages}
              onClick={() =>
                onQueryStateChange({
                  ...queryState,
                  page: page + 1 < totalPages ? page + 1 : page,
                })
              }
              variant="outline"
            >
              Next
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? <Skeleton className="h-[240px] w-full" /> : null}
        {isError ? (
          <DegradedState message="Sessions are temporarily unavailable." />
        ) : null}
        {isLoading || isError ? null : (
          <SyncedSessionsTable
            emptyState={
              <EmptyState
                className="py-12"
                description="No synced sessions match the current filters."
                icon={Clock3Icon}
                title="No sessions found"
              />
            }
            extraColumnLabel={extraColumnLabel}
            getSessionHref={getSessionHref}
            items={items}
            renderExtraColumn={renderExtraColumn}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ContextCards({
  targets,
}: Readonly<{
  targets: AgentSessionLastSyncTarget[];
}>) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock3Icon className="h-4 w-4" />
            Compute Target Freshness
          </CardTitle>
          <CardDescription>
            Last successful sync timestamps per compute target.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ComputeTargetSyncTable
            rows={targets.map((target) => ({
              id: target.computeTargetId,
              lastSeenLabel: formatRelativeTime(target.lastSeenAt),
              lastSyncLabel: target.lastAgentSessionSyncAt
                ? formatRelativeTime(target.lastAgentSessionSyncAt)
                : "Never",
              machineName: target.machineName,
              online: target.isOnline,
              ownerLabel:
                [target.owner.firstName, target.owner.lastName]
                  .filter(Boolean)
                  .join(" ") || target.owner.email,
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderGit2Icon className="h-4 w-4" />
            Working Context
          </CardTitle>
          <CardDescription>
            The monitoring view preserves repository and worktree hints from the
            desktop sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex items-start gap-3">
            <HardDriveDownloadIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <div className="font-medium">Historical backfill</div>
              <p className="text-muted-foreground">
                Once a compute target reconnects, historical sessions are
                backfilled into the org view automatically.
              </p>
            </div>
          </div>
          <Separator />
          <div className="flex items-start gap-3">
            <ArrowRightIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <div className="font-medium">Session detail</div>
              <p className="text-muted-foreground">
                Open any session row to inspect token usage, agents, and the
                event timeline captured from the desktop monitor.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyTelemetryState() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          className="py-16"
          description="Connect a compute target with desktop agent-session sync enabled to start populating this view."
          icon={MonitorIcon}
          title="No agent session data yet"
        />
      </CardContent>
    </Card>
  );
}

function MetadataAvailabilityNotice({
  isError,
  isLoading,
  kind,
  selectedId,
}: Readonly<{
  kind: "project" | "team";
  selectedId: string | null;
  isLoading: boolean;
  isError: boolean;
}>) {
  if (!(selectedId && (isLoading || isError))) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      Selected {kind} filter {selectedId} remains applied while {kind} metadata
      is {isError ? "unavailable" : "loading"}.
    </p>
  );
}

function withSelectedFallbackOption<T extends { id: string; name: string }>(
  options: T[],
  selectedId: string | null,
  fallbackPrefix: string
): T[] {
  if (!selectedId || options.some((option) => option.id === selectedId)) {
    return options;
  }
  return [
    { id: selectedId, name: `${fallbackPrefix} (${selectedId})` } as T,
    ...options,
  ];
}

function toMetadataOptions(
  value: unknown
): Array<{ id: string; name: string }> {
  return Array.isArray(value) ? value : [];
}

function formatUserName(user: AgentSessionUsageByUser): string {
  return user.userName || user.userEmail;
}
