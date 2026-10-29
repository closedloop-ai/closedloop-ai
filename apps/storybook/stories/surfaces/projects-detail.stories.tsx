import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import {
  DocumentRow,
  getDocumentTableColumnCount,
} from "@repo/app/documents/components/table/document-row";
import { toRowItem } from "@repo/app/documents/components/table/document-tree";
import { DocumentsEmptyState } from "@repo/app/documents/components/table/documents-empty-state";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { DocumentTableHeader } from "@repo/app/documents/components/table/table-header";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { filterByCategory } from "@repo/app/documents/lib/table-view-pipeline";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { EditableProjectDescription } from "@repo/app/projects/components/editable-project-description";
import { EditableProjectTitle } from "@repo/app/projects/components/editable-project-title";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { comparePriorityValuesForSort } from "@repo/app/shared/lib/priority-sort";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import {
  makeArtifact,
  makeFeatureArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { userKeys } from "@repo/app/users/hooks/use-users";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { ariaTableProps } from "@repo/design-system/lib/grid-table-aria";
import type { Meta, StoryObj } from "@storybook/react";
import { ArrowRightIcon, GitBranchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { fn } from "storybook/test";
import { ProjectArtifactsRegion } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/project-artifacts-region";
import { AppScreenShell, ORG_SLUG } from "./app-shell";

/**
 * Surfaces/Projects/Project Detail — the single-project screen at
 * `/teams/<teamId>/projects/<projectId>`, the other half of the Projects gap
 * flagged in the 2026-09-16 Storybook audit
 * (`docs/design/storybook-audit-2026-09-16.md`).
 *
 * The real page (`.../projects/[projectId]/page.tsx`) is a large Next.js
 * client-component orchestrator (tab state, pagination, permalink
 * redirects…) that this Storybook cannot mount directly, so — matching every
 * other Surfaces page in this file — this composes its real, shipped MID-LEVEL
 * pieces instead:
 *
 * - `ProjectArtifactsRegion` (real, unmodified) wraps the artifact table and
 *   owns the one state the real page uses it for: swapping the table for a
 *   real degraded state when a tree read fails.
 * - `EditableProjectTitle` / `EditableProjectDescription` (real, unmodified —
 *   both already have their own `Composites/Projects/*` stories) render the
 *   Overview tab's name and description exactly as production does.
 * - The artifact list itself reuses the REAL `DocumentTableHeader` and
 *   `DocumentRow` — the same two primitives `DocumentsView` itself composes,
 *   and the same ones `ProjectsTable` already uses on the Listing surface —
 *   plus the real `filterByCategory` pipeline function, rather than
 *   `DocumentsView` itself. See the "HAND-BUILT" note below `DocumentsView`
 *   for exactly why, and the one below `OverviewProperties` for the
 *   Properties panel.
 *
 * Tabs (Overview / All Artifacts / PRDs / Issues / Plans) are the real
 * `ToggleGroup` primitive, genuinely wired to local state — clicking one
 * swaps in different real content, it does not just repaint a static image
 * of the production tab bar.
 */

/**
 * HAND-BUILT — `DocumentsView` (`.../projects/[projectId]/components/
 * documents-view.tsx`) cannot mount in this Storybook: its very first line
 * (`const orgSlug = useOrgSlug();`) unconditionally calls the host app's
 * Clerk-coupled `@/hooks/use-org-slug`, which itself unconditionally calls
 * Clerk's `useOrganization()`/`useAuth()` before it ever reads a route param.
 * Those throw without a mounted `<ClerkProvider>`, and this Storybook mounts
 * none — the same class of wall Settings/Login already document for Clerk's
 * hosted widgets (`apps/storybook/stories/surfaces/settings.stories.tsx`,
 * `login.stories.tsx`). This is not speculation: `apps/app`'s own vitest
 * config globally mocks `@clerk/nextjs` for every test in that package for
 * exactly this reason, and `packages/app/my-tasks/components/
 * my-tasks-card-view.tsx` documents the identical constraint in its own
 * source comment ("the board reaches for the host app's `useOrgSlug` route
 * context, which `@repo/app` cannot import").
 *
 * Rather than reproduce `DocumentsView`'s whole orchestrator (grouping, bulk
 * select, drag-to-rank, merge/move dialogs) as inert lookalike markup — which
 * is exactly the "looks wired but does nothing" defect the 2026-09-16 audit
 * flags elsewhere — this renders the row list with the SAME real, exported
 * primitives `DocumentsView` itself composes for exactly this job
 * (`DocumentTableHeader`, `DocumentRow`, `toRowItem`, `filterByCategory`),
 * genuinely sorted, genuinely filtered by tab. What's approximated is only
 * the orchestrator shell around them (no grouping/bulk-select/drag-rank), not
 * the rows or the header.
 */
function ArtifactsTable({
  documents,
  filterCategory,
  editHandlers,
  onClearFilters,
}: {
  documents: DocumentRowData[];
  filterCategory: FilterCategory;
  editHandlers: RowEditHandlers;
  onClearFilters: () => void;
}) {
  const [sortBy, setSortBy] = useState<ArtifactSortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  // Type only means anything on the merged "All Artifacts" tab — a single
  // category tab (PRDs/Issues/Plans) already says the type in its own label.
  const visibleColumns =
    filterCategory === "all"
      ? [
          DocumentColumn.Type,
          DocumentColumn.Assignee,
          DocumentColumn.Priority,
          DocumentColumn.Tags,
        ]
      : [DocumentColumn.Assignee, DocumentColumn.Priority, DocumentColumn.Tags];

  const filtered = useMemo(
    () => filterByCategory(documents, filterCategory, ""),
    [documents, filterCategory]
  );

  const sorted = useMemo(
    () => sortArtifacts(filtered, sortBy, sortDir),
    [filtered, sortBy, sortDir]
  );

  const ariaColumnCount = getDocumentTableColumnCount(visibleColumns.length);

  if (sorted.length === 0) {
    return (
      <DocumentsEmptyState
        hasAnyItems={documents.length > 0}
        isFilterActive={documents.length > 0}
        onClearFilters={onClearFilters}
      />
    );
  }

  return (
    <div {...ariaTableProps(true, ariaColumnCount)} className="min-w-fit">
      <DocumentTableHeader
        insideAriaTable
        onSort={(column, direction) => {
          setSortBy(column as ArtifactSortColumn);
          setSortDir(direction);
        }}
        sortBy={sortBy}
        sortDir={sortDir}
        visibleColumns={visibleColumns}
      />
      {sorted.map((doc) => (
        <DocumentRow
          editHandlers={editHandlers}
          insideAriaTable
          item={toRowItem(doc)}
          key={doc.id}
          visibleColumns={visibleColumns}
        />
      ))}
    </div>
  );
}

type ArtifactSortColumn = "title" | "type" | "assignee" | "priority";

function sortArtifacts(
  rows: DocumentRowData[],
  sortBy: ArtifactSortColumn | null,
  sortDir: SortDirection
): DocumentRowData[] {
  if (!sortBy) {
    return rows;
  }
  if (sortBy === "priority") {
    return [...rows].sort((a, b) =>
      comparePriorityValuesForSort(a.priority, b.priority, sortDir)
    );
  }
  const multiplier = sortDir === "asc" ? 1 : -1;
  return [...rows].sort(
    (a, b) => multiplier * compareArtifactField(a, b, sortBy)
  );
}

function compareArtifactField(
  a: DocumentRowData,
  b: DocumentRowData,
  column: "title" | "type" | "assignee"
): number {
  if (column === "title") {
    return a.title.localeCompare(b.title);
  }
  if (column === "type") {
    return a.type.localeCompare(b.type);
  }
  const aName = a.assignee ? getUserDisplayName(a.assignee) : "";
  const bName = b.assignee ? getUserDisplayName(b.assignee) : "";
  return aName.localeCompare(bName);
}

/**
 * HAND-BUILT — the real `OverviewProperties` (`.../projects/[projectId]/
 * components/overview-properties.tsx`) also cannot mount here: it
 * unconditionally renders its own nested `RepoCell`, which unconditionally
 * calls the same Clerk-coupled `useOrgSlug()` described above (to build the
 * "Connect GitHub" link's href), so the whole component throws on mount
 * regardless of which props it is given. Rather than drop the Properties
 * panel, this reproduces its layout using the SAME real, Clerk-free
 * primitives `OverviewProperties` itself composes for Priority, Assignee and
 * Due Date — `Select` + `PriorityIcon` + `usePriorityOptions()`,
 * `UserSelectPopover`, `DatePickerPopover` — genuinely wired to the args
 * below. Only the Repos cell is fully hand-drawn: it reuses the real
 * `GITHUB_CONNECT_COPY` string production shows, and links to the same
 * `/<org>/settings?tab=integrations` destination `RepoCell` builds, using the
 * fixed `ORG_SLUG` this whole Storybook already renders every Surface under
 * (`app-shell.tsx`) instead of the blocked hook — a plain link to a real
 * destination, matching how Login's story already substitutes a plain anchor
 * for a route-aware `Link` it cannot mount.
 */
function HandBuiltProperties({
  priority,
  assignee,
  targetDate,
  onUpdatePriority,
  onUpdateAssignee,
  onUpdateTargetDate,
}: {
  priority: Priority | null;
  assignee: PopoverUser | null;
  targetDate: Date | null;
  onUpdatePriority: (priority: Priority) => void;
  onUpdateAssignee: (userId: string | null) => void;
  onUpdateTargetDate: (date: Date | null) => void;
}) {
  const priorityOptions = usePriorityOptions();
  const triggerClassName =
    "border-input-border bg-input hover:bg-muted dark:bg-input dark:hover:bg-muted flex h-8 w-full items-center gap-2 rounded-md border px-3 text-sm text-foreground shadow-none";

  return (
    <div className="space-y-3">
      <h3 className="font-medium text-lg">Properties</h3>
      <div className="flex flex-wrap gap-3">
        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Priority</span>
          <Select
            onValueChange={(value) => onUpdatePriority(value as Priority)}
            value={priority ?? ""}
          >
            <SelectTrigger
              className="w-full text-foreground shadow-none"
              size="sm"
            >
              <SelectValue placeholder="No priority" />
            </SelectTrigger>
            <SelectContent>
              {priorityOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  <span className="inline-flex items-center gap-1.5">
                    <PriorityIcon priority={value} />
                    {PRIORITY_LABELS[value]}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Assignee</span>
          <UserSelectPopover
            onSelect={(user) => onUpdateAssignee(user?.id ?? null)}
            placeholder="Unassigned"
            users={PROPERTY_TEAM_MEMBERS}
            value={assignee}
          />
        </div>

        <div className="flex w-[175px] min-w-[120px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Due Date</span>
          <DatePickerPopover
            fromDate={new Date("2026-01-01")}
            onSelect={onUpdateTargetDate}
            placeholder="Set date"
            value={targetDate}
          />
        </div>

        <div className="flex min-w-[175px] flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Repos</span>
          <Button
            asChild
            className="w-full justify-between shadow-none"
            size="sm"
            variant="outline"
          >
            <a href={`/${ORG_SLUG}/settings?tab=integrations`}>
              <span className="inline-flex items-center gap-2">
                <GitBranchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                {GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel}
              </span>
              <ArrowRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

const TEAM_ID = "team-platform";
const TEAM_NAME = "Platform";
const PROJECT_ID = "proj-design-tokens";
const PROJECT_NAME = "Design Token Rollout";

const OTTILIE: User = {
  id: "u-ottilie",
  clerkId: "clerk-ottilie",
  organizationId: "org-closedloop",
  email: "ottilie@closedloop.ai",
  firstName: "Ottilie",
  lastName: "Eye",
  avatarUrl: null,
  phoneNumber: null,
  role: ApproverRole.TechLead,
  linearId: null,
  slackId: null,
  githubUsername: "ottilieeastwick",
  active: true,
  createdAt: new Date("2025-01-06"),
  updatedAt: new Date("2025-01-06"),
};

const MARISOL: User = {
  id: "u-marisol",
  clerkId: "clerk-marisol",
  organizationId: "org-closedloop",
  email: "marisol@closedloop.ai",
  firstName: "Marisol",
  lastName: "Ashgrove",
  avatarUrl: null,
  phoneNumber: null,
  role: ApproverRole.Engineer,
  linearId: null,
  slackId: null,
  githubUsername: "mashgrove",
  active: true,
  createdAt: new Date("2025-01-06"),
  updatedAt: new Date("2025-01-06"),
};

const PASCOE: User = {
  id: "u-pascoe",
  clerkId: "clerk-pascoe",
  organizationId: "org-closedloop",
  email: "pascoe@closedloop.ai",
  firstName: "Pascoe",
  lastName: "Birchall",
  avatarUrl: null,
  phoneNumber: null,
  role: ApproverRole.Engineer,
  linearId: null,
  slackId: null,
  githubUsername: "pascoebirchall",
  active: true,
  createdAt: new Date("2025-01-06"),
  updatedAt: new Date("2025-01-06"),
};

const ORG_USERS: User[] = [OTTILIE, MARISOL, PASCOE];

const PROPERTY_TEAM_MEMBERS: PopoverUser[] = ORG_USERS.map((user) => ({
  id: user.id,
  name: getUserDisplayName(user),
  email: user.email,
  avatarUrl: user.avatarUrl ?? undefined,
  initials: getUserInitials(user.firstName, user.lastName),
}));

/**
 * Seven artifacts spanning every real category tab (PRDs, Issues, Plans),
 * every status the type actually uses (document statuses for PRDs/Plans,
 * issue statuses for Issues — never mixed across the two vocabularies), a
 * spread of priorities including one unassigned/untagged row, and one tagged
 * row, so the "All Artifacts" tab's Type/Assignee/Priority/Tags columns each
 * show more than one distinct value.
 */
const ARTIFACTS: DocumentRowData[] = [
  makeArtifact({
    id: "art-prd-tokens",
    projectId: PROJECT_ID,
    title: "Design Token Rollout PRD",
    slug: "PRD-142",
    type: DocumentType.Prd,
    status: DocumentStatus.Approved,
    priority: Priority.High,
    assigneeId: OTTILIE.id,
    assignee: OTTILIE,
    updatedAt: new Date("2026-09-14"),
    tags: [
      { id: "tag-design-system", name: "Design System", color: TagColor.Blue },
    ],
  }),
  makeArtifact({
    id: "art-prd-billing",
    projectId: PROJECT_ID,
    title: "Billing Dashboard v2 Spec",
    slug: "PRD-158",
    type: DocumentType.Prd,
    status: DocumentStatus.InReview,
    priority: Priority.Medium,
    assigneeId: null,
    assignee: undefined,
    updatedAt: new Date("2026-09-10"),
  }),
  makeFeatureArtifact({
    id: "art-issue-contrast",
    projectId: PROJECT_ID,
    title: "Add token contrast checker to CI",
    slug: "ISS-2210",
    status: IssueStatus.InProgress,
    priority: Priority.Urgent,
    assigneeId: MARISOL.id,
    assignee: MARISOL,
    updatedAt: new Date("2026-09-15"),
  }),
  makeFeatureArtifact({
    id: "art-issue-timezone",
    projectId: PROJECT_ID,
    title: "Fix due-date timezone bug on due date picker",
    slug: "ISS-2198",
    status: IssueStatus.Todo,
    priority: Priority.Medium,
    assigneeId: PASCOE.id,
    assignee: PASCOE,
    updatedAt: new Date("2026-09-11"),
  }),
  makeFeatureArtifact({
    id: "art-issue-audit",
    projectId: PROJECT_ID,
    title: "Audit color tokens for AA contrast",
    slug: "ISS-2177",
    status: IssueStatus.Done,
    priority: Priority.Low,
    assigneeId: PASCOE.id,
    assignee: PASCOE,
    updatedAt: new Date("2026-09-02"),
  }),
  makeFeatureArtifact({
    id: "art-issue-triage",
    projectId: PROJECT_ID,
    title: "Unclear button contrast on hover state",
    slug: "ISS-2231",
    status: IssueStatus.Triage,
    priority: Priority.Low,
    assigneeId: null,
    assignee: undefined,
    updatedAt: new Date("2026-09-15"),
  }),
  makePlanArtifact({
    id: "art-plan-rollout",
    projectId: PROJECT_ID,
    title: "Token Rollout Implementation Plan",
    slug: "PLAN-64",
    status: DocumentStatus.Executed,
    priority: Priority.High,
    assigneeId: OTTILIE.id,
    assignee: OTTILIE,
    updatedAt: new Date("2026-08-29"),
  }),
];

const TABS = [
  { label: "Overview", value: "overview" },
  { label: "All Artifacts", value: "all" },
  { label: "PRDs", value: "documents" },
  { label: "Issues", value: "issues" },
  { label: "Plans", value: "plans" },
] as const;
type ProjectTab = (typeof TABS)[number]["value"];

const TAB_TO_FILTER_CATEGORY: Record<
  Exclude<ProjectTab, "overview">,
  FilterCategory
> = {
  all: "all",
  documents: "documents",
  issues: "features",
  plans: "plans",
};

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

type ProjectDetailScreenProps = {
  /**
   * Org-relative path the sidebar should mark as current. Projects has no
   * primary-nav entry of its own (it is reached through a team), so the
   * honest default is nothing highlighted — matching `Surfaces/Projects/
   * Listing`'s own default.
   */
  activePath?: string;
  /** Which tab reads as selected. */
  activeTab?: ProjectTab;
  /** The `ProjectArtifactsRegion`'s degraded state, in place of the table. */
  artifactsReadFailed?: boolean;
  /** Rows the artifact tabs render. */
  documents?: DocumentRowData[];
};

const ProjectDetailScreen = ({
  activePath = "",
  activeTab: initialTab = "all",
  artifactsReadFailed = false,
  documents = ARTIFACTS,
}: ProjectDetailScreenProps) => {
  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab);
  const [priority, setPriority] = useState<Priority | null>(Priority.High);
  const [assignee, setAssignee] = useState<PopoverUser | null>(
    PROPERTY_TEAM_MEMBERS[0]
  );
  const [targetDate, setTargetDate] = useState<Date | null>(
    new Date("2026-10-15")
  );

  const editHandlers: RowEditHandlers = {
    surfaceVariant: "team",
    teamMembers: PROPERTY_TEAM_MEMBERS,
    onUpdateAssignee: fn(),
    onUpdatePriority: fn(),
  };

  return (
    <AppScreenShell
      activePath={activePath}
      breadcrumbs={[TEAM_NAME, PROJECT_NAME]}
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Real component: `ToggleGroup`, genuinely wired — clicking a tab
            swaps in different real content below, the same merged tab
            control (Overview + artifact categories) the real page uses. */}
        <div className="border-b">
          <div className="flex items-center gap-3 px-4 py-3">
            <ToggleGroup
              aria-label="Filter by artifact type"
              onValueChange={(value) => {
                if (value) {
                  setActiveTab(value as ProjectTab);
                }
              }}
              size="sm"
              type="single"
              value={activeTab}
              variant="outline"
            >
              {TABS.map((tab) => (
                <ToggleGroupItem key={tab.value} value={tab.value}>
                  {tab.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {activeTab === "overview" ? (
            <div className="mx-auto mt-0 flex max-w-[950px] flex-col gap-10 p-6">
              <div className="flex flex-col gap-2">
                {/* Real components, unmodified. */}
                <EditableProjectTitle
                  initialTitle={PROJECT_NAME}
                  projectId={PROJECT_ID}
                />
                <EditableProjectDescription
                  initialDescription="Ship the v2 token set across every product surface."
                  projectId={PROJECT_ID}
                />
              </div>
              <HandBuiltProperties
                assignee={assignee}
                onUpdateAssignee={(userId) =>
                  setAssignee(
                    PROPERTY_TEAM_MEMBERS.find((m) => m.id === userId) ?? null
                  )
                }
                onUpdatePriority={setPriority}
                onUpdateTargetDate={setTargetDate}
                priority={priority}
                targetDate={targetDate}
              />
            </div>
          ) : (
            <div className="mt-0 min-w-fit">
              {/* Real component: `ProjectArtifactsRegion`, unmodified. */}
              <ProjectArtifactsRegion
                hasReadFailed={artifactsReadFailed}
                onRetry={fn()}
              >
                <ArtifactsTable
                  documents={documents}
                  editHandlers={editHandlers}
                  filterCategory={TAB_TO_FILTER_CATEGORY[activeTab]}
                  onClearFilters={fn()}
                />
              </ProjectArtifactsRegion>
            </div>
          )}
        </div>
      </div>
    </AppScreenShell>
  );
};

/**
 * The single-project screen at `/teams/<teamId>/projects/<projectId>`:
 * Overview plus the artifact table, filtered by tab (All Artifacts, PRDs,
 * Issues, Plans).
 */
const meta = {
  title: "Surfaces v1.0/Projects/Project Detail",
  component: ProjectDetailScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    activeTab: {
      options: TABS.map((tab) => tab.value),
      control: { type: "radio" },
      description:
        "Which tab reads as selected on load. Every tab stays live afterward.",
      table: { category: "Content" },
    },
    artifactsReadFailed: {
      control: "boolean",
      description:
        "The real ProjectArtifactsRegion degraded state, in place of the artifact table.",
      table: { category: "State" },
    },
    documents: {
      description:
        "Rows the artifact tabs render. Not a live control — the object is too structured for the Controls panel; switch between the named stories below instead.",
      table: { disable: true },
    },
  },
  args: {
    activePath: "",
    activeTab: "all",
    artifactsReadFailed: false,
    documents: ARTIFACTS,
  },
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, iframeHeight: 900 } },
    appCore: {
      // `EditableProjectTitle` / `EditableProjectDescription` both save
      // through the real `useUpdateProject` mutation port — same fixture
      // shape their own co-located stories use
      // (`packages/app/projects/components/editable-project-title.stories.tsx`).
      apiRoutes: [
        {
          method: "PUT",
          path: "/projects/*",
          respond: () => ({
            id: PROJECT_ID,
            slug: "design-token-rollout",
            teams: [],
          }),
        },
      ],
      queryData: [
        [userKeys.organizationUsers(), ORG_USERS],
        // The header's project-favorite star (useIsFavorite) reads this
        // unconditionally; unseeded, the harness's fixture transport falls
        // back to an unmatched-GET default of `{}`, and `favorites?.some(...)`
        // throws on the missing array (`.data` exists, isn't an array).
        [projectKeys.favorites(), []],
        // DocumentRow (the real row primitive this file composes for the
        // artifact table) renders its own FavoriteButton via
        // useIsFavoriteArtifact, which reads this SEPARATE artifact-level key
        // — same crash, same fix, different hook than the project-level one
        // above.
        [artifactFavoriteKeys.list(), []],
      ],
    },
  },
} satisfies Meta<typeof ProjectDetailScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The "All Artifacts" tab, the real page's default — every category mixed,
 * so the Type column carries real weight. */
export const Default: Story = {};

/** The Overview tab: real editable title/description, and the Properties
 * panel populated with a real priority, assignee and due date. */
export const Overview: Story = {
  args: { activeTab: "overview" },
};

/** The Issues tab — the real `filterByCategory("features")` narrowing, not a
 * hand-picked subset. */
export const Issues: Story = {
  args: { activeTab: "issues" },
};

/** The PRDs tab (`filterByCategory("documents")`, labeled "PRDs" on the real
 * `TABS` bar) — the real two-PRD narrowing over `ARTIFACTS`, not a
 * hand-picked subset. */
export const PRDs: Story = {
  name: "PRDs",
  args: { activeTab: "documents" },
};

/** The Plans tab, populated: the real `filterByCategory("plans")` narrowing
 * over `ARTIFACTS` resolves to its one real Plan fixture (`art-plan-rollout`)
 * — distinct from `NoMatchingArtifacts` below, whose `documents` deliberately
 * excludes every Plan so this same tab renders empty instead. */
export const Plans: Story = {
  args: { activeTab: "plans" },
};

/** A tab with no matching artifacts. The real `DocumentsEmptyState` renders
 * its "narrowed by a filter" copy rather than claiming the project is empty,
 * because `documents` (passed here) is non-empty even though the Plans tab's
 * filtered result is. */
export const NoMatchingArtifacts: Story = {
  name: "No matching artifacts",
  args: {
    activeTab: "plans",
    documents: ARTIFACTS.filter(
      (doc) => doc.type !== DocumentType.ImplementationPlan
    ),
  },
};

/** The real `ProjectArtifactsRegion` degraded state: a tree read failed, so
 * the table is replaced by a retry affordance instead of an empty table. */
export const ArtifactsReadFailed: Story = {
  name: "Artifacts read failed",
  args: { artifactsReadFailed: true },
};
