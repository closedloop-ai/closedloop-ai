/**
 * Static product screenshot for the marketing home page.
 *
 * Mirrors the authenticated project Artifacts page 1:1 with generic data.
 * Structure sources (keep this mock in sync if the product changes):
 *   - Page shell:          apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/page.tsx
 *   - Sidebar:             apps/app/app/(authenticated)/components/sidebar.tsx
 *   - Sidebar teams group: apps/app/app/(authenticated)/components/sidebar-teams.tsx
 *   - Top nav / header:    apps/app/app/(authenticated)/components/header.tsx
 *   - Active loops banner: apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/active-loops-status.tsx
 *   - Artifacts toolbar:   apps/app/app/(authenticated)/teams/[teamId]/projects/[projectId]/page.tsx (filters row)
 *   - Table header:        apps/app/components/document-table/table-header.tsx
 *   - Table row:           apps/app/components/document-table/document-row.tsx
 *   - Group section head:  apps/app/components/document-table/group-section-header.tsx
 *
 * Colors use design-system semantic tokens (bg-sidebar, bg-muted, border-border,
 * text-muted-foreground, etc.) so the mock tracks theme updates automatically.
 * Status-signal colors (blue-500 spinner, red-500 failure) match the product.
 *
 * Columns shown here are only Assignee / Loop / Priority per the marketing
 * brief — the real product supports more columns (see DocumentColumn).
 */

import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  ArrowUpDown,
  Boxes,
  BoxIcon,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  EllipsisIcon,
  FileCode2Icon,
  FileIcon,
  InboxIcon,
  Layers2Icon,
  ListFilter,
  Loader2,
  MonitorIcon,
  MoreHorizontal,
  PanelLeft,
  PlusIcon,
  RotateCcwIcon,
  Search,
  Settings2,
  Star,
  UsersIcon,
} from "lucide-react";

type LoopState = "running" | "completed" | "none";

type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

type Assignee = {
  initials: string;
  name: string;
  tone: string;
};

type Artifact = {
  slug: string;
  title: string;
  assignee: Assignee;
  loop: LoopState;
  priority: Priority;
};

type StatusGroup = {
  label: string;
  status: StatusIconStatus;
  count: number;
  open: boolean;
  artifacts: Artifact[];
};

const ASSIGNEES = {
  jordan: {
    initials: "JM",
    name: "Jordan Miles",
    tone: "bg-blue-100 text-blue-700",
  },
  riley: {
    initials: "RP",
    name: "Riley Park",
    tone: "bg-violet-100 text-violet-700",
  },
  sam: {
    initials: "SK",
    name: "Sam Keller",
    tone: "bg-emerald-100 text-emerald-700",
  },
  ada: {
    initials: "AL",
    name: "Ada Lin",
    tone: "bg-rose-100 text-rose-700",
  },
  morgan: {
    initials: "MT",
    name: "Morgan Tate",
    tone: "bg-amber-100 text-amber-700",
  },
  casey: {
    initials: "CR",
    name: "Casey Rao",
    tone: "bg-cyan-100 text-cyan-700",
  },
  priya: {
    initials: "PD",
    name: "Priya Das",
    tone: "bg-fuchsia-100 text-fuchsia-700",
  },
  ellis: {
    initials: "EW",
    name: "Ellis Wood",
    tone: "bg-sky-100 text-sky-700",
  },
} satisfies Record<string, Assignee>;

const statusGroups: StatusGroup[] = [
  {
    label: "Draft",
    status: "todo",
    count: 21,
    open: false,
    artifacts: [],
  },
  {
    label: "In Progress",
    status: "in-progress",
    count: 3,
    open: true,
    artifacts: [
      {
        slug: "FEA-241",
        title: "Add bulk actions to saved views",
        assignee: ASSIGNEES.jordan,
        loop: "running",
        priority: "MEDIUM",
      },
      {
        slug: "PRD-218",
        title: "Empty state for saved filters",
        assignee: ASSIGNEES.riley,
        loop: "running",
        priority: "HIGH",
      },
      {
        slug: "PLN-402",
        title: "Background job queue migration",
        assignee: ASSIGNEES.sam,
        loop: "running",
        priority: "MEDIUM",
      },
    ],
  },
  {
    label: "In Review",
    status: "in-review",
    count: 3,
    open: true,
    artifacts: [
      {
        slug: "FEA-233",
        title: "Export audit log to CSV",
        assignee: ASSIGNEES.ada,
        loop: "completed",
        priority: "HIGH",
      },
      {
        slug: "PRD-214",
        title: "Webhook retry and backoff policy",
        assignee: ASSIGNEES.morgan,
        loop: "none",
        priority: "MEDIUM",
      },
      {
        slug: "FEA-229",
        title: "Per-channel notification preferences",
        assignee: ASSIGNEES.casey,
        loop: "none",
        priority: "LOW",
      },
    ],
  },
  {
    label: "Approved",
    status: "complete",
    count: 2,
    open: true,
    artifacts: [
      {
        slug: "PLN-398",
        title: "Mobile onboarding redesign",
        assignee: ASSIGNEES.priya,
        loop: "none",
        priority: "MEDIUM",
      },
      {
        slug: "PRD-210",
        title: "Team admin permission tiers",
        assignee: ASSIGNEES.ellis,
        loop: "none",
        priority: "HIGH",
      },
    ],
  },
];

const runningCount = statusGroups
  .flatMap((group) => group.artifacts)
  .filter((artifact) => artifact.loop === "running").length;

const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

export const SystemVisualSection = () => {
  return (
    <section className="w-full bg-gradient-to-t from-primary/15 to-50% to-background pb-16">
      <div className="mx-auto w-full max-w-[1300px] px-6 md:px-10">
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
          <BrowserChrome />
          <div className="flex min-h-[560px]">
            <ProductSidebar />
            <ProjectView />
          </div>
        </div>
      </div>
    </section>
  );
};

/* Browser chrome — decorative wrapper (not part of the real product). */
const BrowserChrome = () => {
  return (
    <div className="flex items-center gap-3 border-border border-b bg-muted/40 px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2 rounded-md bg-background px-3 py-1 text-muted-foreground text-xs ring-1 ring-border">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          app.closedloop.ai/teams/product/projects/mobile-checkout
        </div>
      </div>
      <div className="w-12" />
    </div>
  );
};

/* Sidebar — mirrors apps/app/app/(authenticated)/components/sidebar.tsx
   Uses design-system sidebar tokens: bg-sidebar, text-sidebar-foreground,
   hover:bg-sidebar-accent, border-sidebar-border. */
const ProductSidebar = () => {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground lg:flex">
      <SidebarHeader />
      <SidebarSearch />
      <div className="flex flex-1 flex-col gap-6 px-2 pb-2">
        <WorkspaceGroup />
        <FavoritesGroup />
        <TeamsGroup />
      </div>
      <SidebarFooter />
    </aside>
  );
};

const SidebarHeader = () => {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-primary/15 font-semibold text-primary text-xs">
        A
      </div>
      <span className="flex-1 truncate font-medium text-sm">Acme</span>
      <ChevronDown className="size-4 text-sidebar-foreground/60" />
    </div>
  );
};

const SidebarSearch = () => {
  return (
    <div className="px-2 pb-2">
      <div className="flex items-center gap-2 rounded-md bg-sidebar-accent/60 px-2 py-1.5 text-sidebar-foreground/70 text-xs">
        <Search className="size-3.5" />
        <span>Search</span>
      </div>
    </div>
  );
};

/* Workspace group — mirrors baseWorkspaceItems in sidebar.tsx. */
const workspaceItems = [
  { label: "My Tasks", icon: Boxes, badge: null },
  { label: "Notifications", icon: InboxIcon, badge: 3 },
  { label: "Loops", icon: RotateCcwIcon, badge: null },
];

const WorkspaceGroup = () => {
  return (
    <div className="flex flex-col gap-0.5">
      <GroupLabel>Workspace</GroupLabel>
      {workspaceItems.map((item) => (
        <SidebarMenuItem icon={item.icon} key={item.label} label={item.label}>
          {item.badge === null ? null : (
            <span className="rounded-full bg-primary/15 px-1.5 py-px font-medium text-[10px] text-primary">
              {item.badge}
            </span>
          )}
        </SidebarMenuItem>
      ))}
    </div>
  );
};

/* Favorites group — mirrors sidebar-favorites.tsx. */
const FavoritesGroup = () => {
  return (
    <div className="flex flex-col gap-0.5">
      <GroupLabel>Favorites</GroupLabel>
      <SidebarMenuItem icon={Layers2Icon} label="Mobile checkout" />
      <SidebarMenuItem icon={Layers2Icon} label="Billing overhaul" />
    </div>
  );
};

/* Teams group — mirrors sidebar-teams.tsx TEAM_NAV_ITEMS (Projects, PRDs, Features, Plans). */
const teamNavItems = [
  { label: "Projects", icon: Layers2Icon, active: true },
  { label: "PRDs", icon: FileIcon, active: false },
  { label: "Features", icon: BoxIcon, active: false },
  { label: "Plans", icon: FileCode2Icon, active: false },
];

const TeamsGroup = () => {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="font-medium text-[11px] text-sidebar-foreground/60 uppercase tracking-wide">
          Your Teams
        </span>
        <button
          className="flex size-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
          type="button"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      <SidebarMenuItem icon={UsersIcon} label="Product" />
      <div className="ml-4 flex flex-col gap-0.5 border-sidebar-border border-l pl-2">
        {teamNavItems.map((item) => (
          <SidebarSubMenuItem
            active={item.active}
            icon={item.icon}
            key={item.label}
            label={item.label}
          />
        ))}
      </div>
      <SidebarMenuItem icon={UsersIcon} label="Platform" />
    </div>
  );
};

const GroupLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="px-2 pb-1 font-medium text-[11px] text-sidebar-foreground/60 uppercase tracking-wide">
    {children}
  </span>
);

type SidebarMenuItemProps = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  children?: React.ReactNode;
};

const SidebarMenuItem = ({
  icon: Icon,
  label,
  active,
  children,
}: SidebarMenuItemProps) => {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60"
      }`}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {children}
    </div>
  );
};

const SidebarSubMenuItem = ({
  icon: Icon,
  label,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
}) => {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60"
      }`}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
    </div>
  );
};

const SidebarFooter = () => {
  return (
    <div className="flex flex-col gap-2 border-sidebar-border border-t px-2 py-2">
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground/85 text-xs hover:bg-sidebar-accent/60">
        <MonitorIcon className="size-3.5" />
        <span className="flex-1 truncate">Local</span>
        <ChevronDown className="size-3.5 text-sidebar-foreground/60" />
      </div>
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent/60">
        <div className="flex size-6 items-center justify-center rounded-full bg-primary/15 font-medium text-[10px] text-primary">
          AC
        </div>
        <span className="truncate text-sm">Alex Chen</span>
      </div>
    </div>
  );
};

/* Main project view — mirrors the (authenticated) project page layout. */
const ProjectView = () => {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ProjectHeader />
      <ProjectTabs />
      <ArtifactsToolbar />
      <ActiveLoopsBanner />
      <ArtifactsTable />
    </div>
  );
};

/* Header — mirrors apps/app/app/(authenticated)/components/header.tsx.
   Breadcrumb "Team > Project" + star button + Actions + more menu. */
const ProjectHeader = () => {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-border border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <button
          aria-label="Toggle sidebar"
          className="-ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50"
          type="button"
        >
          <PanelLeft className="size-4" />
        </button>
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Product</span>
          <ChevronRight className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Mobile checkout</span>
        </div>
        <button
          aria-label="Favorite"
          className="ml-1 flex size-6 items-center justify-center rounded-md hover:bg-accent/50"
          type="button"
        >
          <Star className="size-4 fill-yellow-400 text-yellow-400" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-foreground text-xs shadow-sm"
          type="button"
        >
          Actions
          <ChevronDown className="size-3.5" />
        </button>
        <button
          aria-label="More actions"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50"
          type="button"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
    </header>
  );
};

/* Tabs — mirrors UnderlineTabsList in the project page. */
const tabs = [
  { label: "Overview", active: false },
  { label: "Artifacts", active: true },
  { label: "Workflows", active: false },
];

const ProjectTabs = () => {
  return (
    <div className="flex items-center gap-4 border-border border-b px-4">
      {tabs.map((tab) => (
        <div
          className={`border-b-2 py-2.5 font-medium text-sm ${
            tab.active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground"
          }`}
          key={tab.label}
        >
          {tab.label}
        </div>
      ))}
    </div>
  );
};

/* Toolbar — mirrors the filters row in the project page (ToggleGroup + search + Filter + View). */
const filterChips = [
  { label: "All", active: true },
  { label: "PRDs", active: false },
  { label: "Features", active: false },
  { label: "Plans", active: false },
  { label: "Branches", active: false },
];

const ArtifactsToolbar = () => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3">
      <div className="flex items-center">
        <div className="inline-flex rounded-md border border-border bg-background p-0.5">
          {filterChips.map((chip) => (
            <span
              className={`rounded px-2.5 py-1 font-medium text-xs ${
                chip.active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground"
              }`}
              key={chip.label}
            >
              {chip.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-[220px]">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
          <div className="flex h-8 items-center rounded-md border border-input-border bg-background pr-3 pl-8 text-muted-foreground text-xs">
            Filter items...
          </div>
        </div>
        <div className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 font-medium text-muted-foreground text-xs">
          <ListFilter className="size-3.5" />
          Filter
        </div>
        <div className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 font-medium text-muted-foreground text-xs">
          <Settings2 className="size-3.5" />
          View
        </div>
      </div>
    </div>
  );
};

/* Active loops banner — mirrors active-loops-status.tsx exactly. */
const ActiveLoopsBanner = () => {
  return (
    <div className="flex items-center gap-2 border-border border-b bg-muted/50 px-6 py-2">
      <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
      <MonitorIcon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-muted-foreground text-sm">
        {runningCount} loops running
      </span>
    </div>
  );
};

/* Table — mirrors document-table/table-header.tsx + documents-view.tsx.
   Column set is restricted to Assignee / Loop / Priority per the marketing brief. */
const ArtifactsTable = () => {
  return (
    <div className="flex-1 overflow-hidden">
      <TableHeaderRow />
      {statusGroups.map((group) => (
        <StatusGroupSection group={group} key={group.label} />
      ))}
    </div>
  );
};

const COLUMN_GRID = "grid-cols-[minmax(0,1fr)_124px_124px_124px_40px]" as const;

const TableHeaderRow = () => {
  return (
    <div
      className={`sticky top-0 z-10 grid h-10 border-border border-b bg-background ${COLUMN_GRID}`}
    >
      <div className="flex min-w-0 items-center py-2 pr-3 pl-4">
        <HeaderLabel label="Name" />
      </div>
      <div className="flex h-10 min-w-0 items-center border-border border-l px-3 py-2">
        <HeaderLabel label="Assignee" />
      </div>
      <div className="flex h-10 min-w-0 items-center border-border border-l px-3 py-2">
        <HeaderLabel label="Loop" />
      </div>
      <div className="flex h-10 min-w-0 items-center border-border border-l px-3 py-2">
        <HeaderLabel label="Priority" />
      </div>
      <div className="h-10 border-border border-l" />
    </div>
  );
};

const HeaderLabel = ({ label }: { label: string }) => (
  <span className="flex items-center gap-1 truncate font-medium text-muted-foreground text-xs">
    {label}
    <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
  </span>
);

/* Group section header — mirrors document-table/group-section-header.tsx. */
const StatusGroupSection = ({ group }: { group: StatusGroup }) => {
  return (
    <div>
      <div className="flex w-full items-center gap-2.5 border-border border-b bg-muted/50 py-2.5 pr-4 pl-[18px] font-medium text-sm">
        {group.open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon size={16} status={group.status} />
        <span>{group.label}</span>
        <span className="text-muted-foreground text-xs">{group.count}</span>
      </div>
      {group.open &&
        group.artifacts.map((artifact) => (
          <ArtifactRow
            artifact={artifact}
            key={artifact.slug}
            rowStatus={group.status}
          />
        ))}
    </div>
  );
};

/* Row — mirrors the artifact variant of DocumentRow in document-row.tsx.
   Cell heights (h-11), widths (w-[124px]), borders (border-l), and the
   leading name layout (chevron slot + slug + status icon + title) match.
   The per-row status icon reflects the section the artifact lives in. */
const ArtifactRow = ({
  artifact,
  rowStatus,
}: {
  artifact: Artifact;
  rowStatus: StatusIconStatus;
}) => {
  return (
    <div
      className={`grid h-11 border-border border-b transition-colors hover:bg-accent/50 ${COLUMN_GRID}`}
    >
      <NameCell artifact={artifact} rowStatus={rowStatus} />
      <AssigneeCell assignee={artifact.assignee} />
      <LoopCell artifact={artifact} />
      <PriorityCell priority={artifact.priority} />
      <MoreMenuCell />
    </div>
  );
};

const NameCell = ({
  artifact,
  rowStatus,
}: {
  artifact: Artifact;
  rowStatus: StatusIconStatus;
}) => {
  return (
    <div className="flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-30" />
      </div>
      <span className="mr-1.5 ml-1 inline-block w-[58px] shrink-0 font-mono text-muted-foreground text-xs">
        {artifact.slug}
      </span>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        <StatusIcon
          size={16}
          status={rowStatus}
          thinking={artifact.loop === "running"}
        />
      </div>
      <div className="ml-2 min-w-0 flex-1">
        <span className="block truncate font-medium text-base text-foreground">
          {artifact.title}
        </span>
      </div>
    </div>
  );
};

const AssigneeCell = ({ assignee }: { assignee: Assignee }) => {
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-border border-l px-3 py-2">
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px] ${assignee.tone}`}
      >
        {assignee.initials}
      </span>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {assignee.name}
      </span>
    </div>
  );
};

/* Loop cell — mirrors LoopCell in document-row.tsx.
   Running:   Loader2 (blue-500) + Monitor + user name.
   Completed: CheckCircle2 + "Loop Completed" (success token). */
const LoopCell = ({ artifact }: { artifact: Artifact }) => {
  if (artifact.loop === "running") {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-border border-l px-3 py-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
        <MonitorIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-muted-foreground text-xs">
          {artifact.assignee.name.split(" ")[0]}
        </span>
      </div>
    );
  }
  if (artifact.loop === "completed") {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-border border-l px-3 py-2">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        <span className="truncate font-medium text-success text-xs">
          Loop Completed
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-border border-l px-3 py-2">
      <span className="font-medium text-muted-foreground text-xs">—</span>
    </div>
  );
};

const PriorityCell = ({ priority }: { priority: Priority }) => {
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-border border-l px-3 py-2">
      <div className="flex shrink-0 items-center p-2">
        <PriorityIcon priority={priority} />
      </div>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {PRIORITY_LABELS[priority]}
      </span>
    </div>
  );
};

const MoreMenuCell = () => {
  return (
    <div className="flex h-11 items-center justify-center border-border border-l">
      <EllipsisIcon className="size-4 text-muted-foreground/40" />
    </div>
  );
};
