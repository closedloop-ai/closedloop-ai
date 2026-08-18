"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FolderGit2Icon,
  FolderGitIcon,
  HistoryIcon,
  TerminalIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { CollaboratorStack, HARNESS_META, KIND_META } from "../component-meta";
import {
  type Branch,
  branchesFor,
  type ComponentVersion,
  componentMetrics,
  detailFor,
  sessionRowMeta,
  sessionsFor,
  versionsFor,
  versionUsed,
} from "../detail-data";
import {
  type AgentComponent,
  AgentComponentKind,
  collaboratorsFor,
  type MockSession,
} from "../mock";
import { type FilterOption, TableFilterMenu } from "./agents-filter-menu";
import { AgentsViewMenu } from "./agents-view-menu";
import { BRANCH_COLUMNS, branchStatusLabel } from "./branches-table";
import { DetailBranchesTab } from "./detail-branches-tab";
import { DetailSessionsTab } from "./detail-sessions-tab";
import { SESSION_COLUMNS, sessionStatusLabel } from "./sessions-table";
import { type TableDimension, useTableControls } from "./use-table-controls";

// Filter / group facets for the detail tables. Owner, Status, and Repository
// mirror the way the main inventory table is filtered and grouped.
const dimensionIcon = (Icon: typeof UserIcon) => (
  <Icon className="size-4 text-muted-foreground" />
);

const SESSION_DIMENSIONS: readonly TableDimension<MockSession>[] = [
  {
    key: "owner",
    label: "Owner",
    icon: dimensionIcon(UserIcon),
    value: (session) => session.user,
  },
  {
    key: "status",
    label: "Status",
    icon: dimensionIcon(CircleDotIcon),
    value: (session) => sessionStatusLabel(session.state),
  },
  {
    key: "repo",
    label: "Repository",
    icon: dimensionIcon(FolderGit2Icon),
    value: (session) => sessionRowMeta(session).repo,
  },
];

const BRANCH_DIMENSIONS: readonly TableDimension<Branch>[] = [
  {
    key: "owner",
    label: "Owner",
    icon: dimensionIcon(UserIcon),
    value: (branch) => branch.owner,
  },
  {
    key: "status",
    label: "Status",
    icon: dimensionIcon(CircleDotIcon),
    value: (branch) => branchStatusLabel(branch.state),
  },
  {
    key: "repo",
    label: "Repository",
    icon: dimensionIcon(FolderGit2Icon),
    value: (branch) => branch.repo,
  },
];

const DetailHeader = ({
  component,
  detail,
}: {
  component: AgentComponent;
  detail: ReturnType<typeof detailFor>;
}) => {
  const KindIcon = KIND_META[component.kind].icon;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
        <KindIcon className="size-3.5" />
        {KIND_META[component.kind].label}
      </span>
      <h1 className="font-semibold text-2xl tracking-tight">
        {component.name}
      </h1>
      <span className="text-muted-foreground text-xs">{detail.path}</span>
    </div>
  );
};

const PropRow = ({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="grid grid-cols-[120px_1fr] items-center gap-3">
    <span className="font-medium text-muted-foreground text-sm">{label}</span>
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {icon ? (
        <span className="shrink-0 text-muted-foreground">{icon}</span>
      ) : null}
      {children}
    </div>
  </div>
);

const PropValue = ({ children }: { children: React.ReactNode }) => (
  <span className="truncate">{children}</span>
);

// Descriptive attributes only, laid out like the desktop app's Properties
// panel: a collapsible header over a muted two-column grid of labeled values,
// each with a small leading icon. Usage numbers (LOC / $, Invocations,
// Sessions) live in the metric cards below, not here.
const PropertiesPanel = ({
  component,
  currentVersion,
}: {
  component: AgentComponent;
  currentVersion: string;
}) => {
  const [open, setOpen] = useState(true);
  const KindIcon = KIND_META[component.kind].icon;

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center gap-1.5 font-semibold text-lg tracking-tight"
          type="button"
        >
          Properties
          {open ? (
            <ChevronDownIcon className="size-5" />
          ) : (
            <ChevronRightIcon className="size-5" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2.5">
        <div className="rounded-lg bg-muted/40 px-5 py-4">
          <div className="grid grid-cols-1 gap-x-12 gap-y-3.5 md:grid-cols-2">
            <PropRow icon={<KindIcon className="size-3.5" />} label="Type">
              <PropValue>{KIND_META[component.kind].label}</PropValue>
            </PropRow>
            <PropRow
              icon={<HistoryIcon className="size-3.5" />}
              label="Version"
            >
              <PropValue>{currentVersion}</PropValue>
            </PropRow>

            <PropRow
              icon={<FolderGitIcon className="size-3.5" />}
              label="Source"
            >
              <PropValue>{component.source}</PropValue>
            </PropRow>

            <PropRow
              icon={<TerminalIcon className="size-3.5" />}
              label="Harness"
            >
              <PropValue>{HARNESS_META[component.harness].label}</PropValue>
            </PropRow>
            <PropRow
              icon={<UsersIcon className="size-3.5" />}
              label="Collaborators"
            >
              <CollaboratorStack users={collaboratorsFor(component)} />
            </PropRow>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

// Agents, commands, and skills render their actual prompt/text (read-only). It
// can be long, so the panel is capped and scrolls on overflow.
const PROMPT_KINDS: ReadonlySet<AgentComponentKind> = new Set([
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
]);

const PromptPanel = ({
  versions,
}: {
  versions: readonly ComponentVersion[];
}) => {
  const [selectedId, setSelectedId] = useState(versions[0].id);
  const active =
    versions.find((version) => version.id === selectedId) ?? versions[0];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-semibold text-lg tracking-tight">Prompt</h3>
        <Select onValueChange={setSelectedId} value={selectedId}>
          <SelectTrigger className="h-8 w-[188px]" size="sm">
            <span className="flex items-center gap-1.5">
              <HistoryIcon className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent align="end">
            {versions.map((version) => (
              <SelectItem key={version.id} value={version.id}>
                {version.id}
                <span className="ml-1.5 text-muted-foreground text-xs">
                  {version.createdAgo}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="rounded-lg bg-muted/40 py-4 pr-2 pl-4">
        <div className="scrollbar-overlay max-h-96 overflow-auto pr-2">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {active.source}
          </div>
        </div>
      </div>
    </div>
  );
};

export const AgentDetail = ({ component }: { component: AgentComponent }) => {
  const detail = detailFor(component);
  const metrics = componentMetrics(component);

  // Agents, skills, and commands are versioned: the prompt panel can page back
  // through revisions, and each session/branch records the version that ran.
  const versions = versionsFor(component, detail.source);
  const sessions = sessionsFor(component).map((session) => ({
    ...session,
    version: versionUsed(versions, session.id),
  }));
  const branches = branchesFor(component).map((branch) => ({
    ...branch,
    version: versionUsed(versions, branch.id),
  }));

  // The Version facet is filterable (newest first, current version flagged) but
  // is not offered as a Group by option, so it is composed onto the filter
  // dimensions only.
  const currentVersionId = versions[0].id;
  const versionRank = new Map(
    versions.map((version, index) => [version.id, index])
  );
  const versionDisplay = (id: string) =>
    id === currentVersionId ? `${id} (Current)` : id;
  const sortByVersion = (a: FilterOption, b: FilterOption) =>
    (versionRank.get(a.value) ?? 0) - (versionRank.get(b.value) ?? 0);

  const sessionFilterDimensions: TableDimension<MockSession>[] = [
    ...SESSION_DIMENSIONS,
    {
      key: "version",
      label: "Version",
      icon: dimensionIcon(HistoryIcon),
      value: (session) => session.version ?? "",
      display: versionDisplay,
      sortOptions: sortByVersion,
    },
  ];
  const branchFilterDimensions: TableDimension<Branch>[] = [
    ...BRANCH_DIMENSIONS,
    {
      key: "version",
      label: "Version",
      icon: dimensionIcon(HistoryIcon),
      value: (branch) => branch.version ?? "",
      display: versionDisplay,
      sortOptions: sortByVersion,
    },
  ];

  const [activeTab, setActiveTab] = useState("sessions");

  const sessionControls = useTableControls<MockSession>({
    items: sessions,
    columns: SESSION_COLUMNS,
    dimensions: sessionFilterDimensions,
    groupables: SESSION_DIMENSIONS,
  });
  const branchControls = useTableControls<Branch>({
    items: branches,
    columns: BRANCH_COLUMNS,
    dimensions: branchFilterDimensions,
    groupables: BRANCH_DIMENSIONS,
  });

  const activeControls =
    activeTab === "branches" ? branchControls : sessionControls;

  return (
    <div className="flex-1 overflow-auto">
      {/* Title, properties, prompt, and metrics stay inset (centered column). */}
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 pt-10 pb-6">
        <DetailHeader component={component} detail={detail} />

        <div
          className={cn(
            "grid grid-cols-2 gap-3 sm:grid-cols-3",
            metrics.length >= 6 ? "lg:grid-cols-6" : "lg:grid-cols-5"
          )}
        >
          {metrics.map((metric) => (
            <MetricCard
              info={metric.info}
              key={metric.key}
              label={metric.label}
              value={metric.value}
            />
          ))}
        </div>

        <PropertiesPanel
          component={component}
          currentVersion={versions[0].id}
        />
        {PROMPT_KINDS.has(component.kind) ? (
          <PromptPanel versions={versions} />
        ) : null}
      </div>

      {/* The Sessions/Branches table spans the full page width (full-bleed,
          like the main agents table); only the title and tab controls stay
          inset. */}
      <div className="pb-6">
        <Tabs className="gap-4" onValueChange={setActiveTab} value={activeTab}>
          <div className="flex flex-wrap items-center justify-between gap-4 px-4">
            <h3 className="font-semibold text-lg tracking-tight">
              Invocations
            </h3>
            <div className="flex items-center gap-2">
              <TabsList>
                <TabsTrigger value="sessions">Sessions</TabsTrigger>
                <TabsTrigger value="branches">Branches</TabsTrigger>
              </TabsList>
              <TableFilterMenu
                align="end"
                dimensions={activeControls.filterMenu.dimensions}
              />
              <AgentsViewMenu {...activeControls.viewMenu} align="end" />
            </div>
          </div>
          <TabsContent value="sessions">
            <DetailSessionsTab
              groupIcon={sessionControls.groupIcon}
              groups={sessionControls.groups}
              hiddenColumns={sessionControls.hiddenColumns}
              sessions={sessionControls.flatItems}
            />
          </TabsContent>
          <TabsContent value="branches">
            <DetailBranchesTab
              branches={branchControls.flatItems}
              groupIcon={branchControls.groupIcon}
              groups={branchControls.groups}
              hiddenColumns={branchControls.hiddenColumns}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};
