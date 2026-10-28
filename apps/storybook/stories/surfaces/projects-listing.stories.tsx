import { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { TeamMember } from "@repo/api/src/types/teams";
import { TeamRole } from "@repo/api/src/types/teams";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import {
  type ColumnVisibility,
  DocumentColumn,
  PROJECT_DEFAULT_COLUMNS,
} from "@repo/app/shared/hooks/use-column-visibility";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { teamKeys } from "@repo/app/teams/hooks/use-teams";
import { userKeys } from "@repo/app/users/hooks/use-users";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";
import { CreateProjectModal } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/components/create-project-modal";
import { ProjectsTable } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/components/projects-table";
import { AppScreenShell } from "./app-shell";

/**
 * Surfaces/Projects/Listing — the second of the two real gaps from the
 * 2026-09-16 Storybook audit (`docs/design/storybook-audit-2026-09-16.md`).
 *
 * Projects is a real artifact type with a real listing screen live in
 * production today: `apps/app/app/(authenticated)/[orgSlug]/teams/[teamId]/
 * projects/page.tsx` (`TeamProjectsPage`). That page itself is a thin
 * client-component orchestrator built on `useRouteParams`/`useNavigation`/
 * `useOrgSlug` — Next-router-specific hooks this Storybook cannot resolve
 * cleanly — so, matching how every other Surfaces page in this file composes
 * real MID-LEVEL pieces rather than the Next.js page itself, this mounts the
 * page's own two reusable, prop-driven children directly:
 *
 * - `ProjectsTable` (`.../projects/components/projects-table.tsx`) — the real,
 *   shipped table. It shares its header/row renderers (`DocumentTableHeader`,
 *   `DocumentRow`) with the Documents tree, so this is the exact same table a
 *   viewer sees at `/teams/<teamId>/projects`, not a lookalike: same sort
 *   comparators (title/priority/assignee/due date/updated), same inline-edit
 *   cells, same delete-confirmation flow, same empty state.
 * - `CreateProjectModal` (`.../projects/components/create-project-modal.tsx`)
 *   — the real "Add Project" dialog, with its live name/description/priority/
 *   target-date/assignee fields, sharing one open/close state with the
 *   table's empty-state "Create Project" action exactly as `page.tsx` wires
 *   the two together.
 *
 * Neither component imports `useOrgSlug` or anything else Clerk- or
 * Next-router-scoped, so both mount here unmodified. Their own data hooks
 * (`useOrganizationUsers`, `useCurrentUser`, `useTeamMembers`,
 * `useFeatureFlagEnabledOptional`) resolve through the global
 * `AppCoreStoryProviders` harness via this story's `appCore.queryData`,
 * exactly as production resolves them through a live QueryClient — nothing
 * here is mocked at the component level.
 *
 * The page's own title bar (`<h1>Projects</h1>` + `TableViewMenu`) is plain,
 * hook-free JSX copied from `page.tsx`, so the real column-visibility menu is
 * mounted here too rather than reinvented.
 */

const TEAM_ID = "team-platform";
const TEAM_NAME = "Platform";

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

const MORDECAI: User = {
  id: "u-mordecai",
  clerkId: "clerk-mordecai",
  organizationId: "org-closedloop",
  email: "mordecai.swinburne@closedloop.ai",
  firstName: "Mordecai",
  lastName: "Saltmarsh",
  avatarUrl: null,
  phoneNumber: null,
  role: ApproverRole.Designer,
  linearId: null,
  slackId: null,
  githubUsername: "msaltmarsh",
  active: true,
  createdAt: new Date("2025-01-06"),
  updatedAt: new Date("2025-01-06"),
};

const ORG_USERS: User[] = [OTTILIE, MARISOL, PASCOE, MORDECAI];

const TEAM_MEMBERS: TeamMember[] = ORG_USERS.map((user, index) => ({
  id: `member-${user.id}`,
  teamId: TEAM_ID,
  userId: user.id,
  role: index === 0 ? TeamRole.Owner : TeamRole.Member,
  createdAt: new Date("2025-01-06"),
  user,
}));

/**
 * Six projects, deliberately spread across every real status the listing
 * shows (`excludeStatus: [Archived]` on the production query — Archived
 * never reaches this table), every priority including the real unset (`null`)
 * value, assigned and unassigned rows, and both a future and a null target
 * date — so every column this table renders shows at least one real, distinct
 * value rather than a wall of repeated placeholders.
 */
const PROJECTS: ProjectWithDetails[] = [
  {
    id: "proj-design-tokens",
    organizationId: "org-closedloop",
    name: "Design Token Rollout",
    description: "Ship the v2 token set across every product surface.",
    priority: Priority.High,
    status: ProjectStatus.InProgress,
    assigneeId: OTTILIE.id,
    assignee: OTTILIE,
    createdById: OTTILIE.id,
    slug: "design-token-rollout",
    targetDate: new Date("2026-10-15"),
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: 0,
    createdAt: new Date("2026-07-01"),
    updatedAt: new Date("2026-09-10"),
    completionPercentage: 62,
    teams: [{ id: TEAM_ID, name: TEAM_NAME }],
  },
  {
    id: "proj-onboarding-revamp",
    organizationId: "org-closedloop",
    name: "Mobile Onboarding Revamp",
    description: "Cut time-to-first-session for new mobile installs.",
    priority: Priority.Urgent,
    status: ProjectStatus.NotStarted,
    assigneeId: MARISOL.id,
    assignee: MARISOL,
    createdById: MARISOL.id,
    slug: "mobile-onboarding-revamp",
    targetDate: new Date("2026-09-30"),
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: 1,
    createdAt: new Date("2026-08-12"),
    updatedAt: new Date("2026-09-12"),
    completionPercentage: 0,
    teams: [{ id: TEAM_ID, name: TEAM_NAME }],
  },
  {
    id: "proj-billing-dashboard",
    organizationId: "org-closedloop",
    name: "Billing Dashboard v2",
    description: null,
    priority: Priority.Medium,
    status: ProjectStatus.InProgress,
    assigneeId: null,
    assignee: undefined,
    createdById: PASCOE.id,
    slug: "billing-dashboard-v2",
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: 2,
    createdAt: new Date("2026-06-20"),
    updatedAt: new Date("2026-09-08"),
    completionPercentage: 34,
    teams: [{ id: TEAM_ID, name: TEAM_NAME }],
  },
  {
    id: "proj-accessibility-audit",
    organizationId: "org-closedloop",
    name: "Accessibility Audit",
    description: "WCAG 2.2 AA pass across the authenticated shell.",
    priority: Priority.Low,
    status: ProjectStatus.Completed,
    assigneeId: PASCOE.id,
    assignee: PASCOE,
    createdById: PASCOE.id,
    slug: "accessibility-audit",
    targetDate: new Date("2026-08-01"),
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: 3,
    createdAt: new Date("2026-05-04"),
    updatedAt: new Date("2026-08-01"),
    completionPercentage: 100,
    teams: [{ id: TEAM_ID, name: TEAM_NAME }],
  },
  {
    id: "proj-search-relevance",
    organizationId: "org-closedloop",
    name: "Search Relevance Tuning",
    description: "Re-rank unified search against the new click log.",
    // The real unset-priority value (ISS-9441) — distinct from Low, not a
    // stand-in for it. Exercises the same fold `ProjectsTable` already covers.
    priority: null,
    status: ProjectStatus.NotStarted,
    assigneeId: MORDECAI.id,
    assignee: MORDECAI,
    createdById: MORDECAI.id,
    slug: "search-relevance-tuning",
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: 4,
    createdAt: new Date("2026-09-01"),
    updatedAt: new Date("2026-09-14"),
    completionPercentage: 0,
    teams: [{ id: TEAM_ID, name: TEAM_NAME }],
  },
  {
    id: "proj-notification-center",
    organizationId: "org-closedloop",
    name: "Notification Center",
    description: "Unify in-app, email and Slack notification preferences.",
    priority: Priority.High,
    status: ProjectStatus.InProgress,
    assigneeId: OTTILIE.id,
    assignee: OTTILIE,
    createdById: OTTILIE.id,
    slug: "notification-center",
    targetDate: new Date("2026-11-01"),
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: 5,
    createdAt: new Date("2026-08-22"),
    updatedAt: new Date("2026-09-15"),
    completionPercentage: 18,
    teams: [{ id: TEAM_ID, name: TEAM_NAME }],
  },
];

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

const DEFAULT_COLUMN_VISIBILITY: ColumnVisibility = Object.fromEntries(
  Object.values(DocumentColumn).map((column) => [
    column,
    PROJECT_DEFAULT_COLUMNS.includes(column),
  ])
) as ColumnVisibility;

type ProjectsListingScreenProps = {
  /** Org-relative path the sidebar should mark as current. Projects has no
   * primary-nav entry of its own (it is reached through a team), so the
   * honest default is nothing highlighted. */
  activePath?: string;
  /** Rows the real `ProjectsTable` renders. */
  projects?: ProjectWithDetails[];
  /**
   * Pre-opens the real `CreateProjectModal` so its fields render without a
   * click. Only read once, as this story's initial state — every story
   * leaves the real open/close wiring live afterward, so both the modal's
   * own trigger and the table's empty-state "Create Project" action keep
   * working normally regardless of which story started it open.
   */
  createModalOpen?: boolean;
};

const ProjectsListingScreen = ({
  activePath = "",
  projects = PROJECTS,
  createModalOpen = false,
}: ProjectsListingScreenProps) => {
  const [createOpen, setCreateOpen] = useState(createModalOpen);
  const [visibility, setVisibility] = useState<ColumnVisibility>(
    DEFAULT_COLUMN_VISIBILITY
  );
  const visibleColumns = PROJECT_DEFAULT_COLUMNS.filter(
    (column) => visibility[column] !== false
  );

  return (
    <AppScreenShell
      activePath={activePath}
      breadcrumbs={[TEAM_NAME, "Projects"]}
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Hand-written on purpose, matching `page.tsx` verbatim: the real
            page inlines this exact title bar above `ProjectsTable` rather than
            mounting a heading component, so there is no real component to
            mount here either — same reasoning Dashboard's heading uses. */}
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Projects</h1>
          {/* Real component: the same column-visibility menu the page mounts. */}
          <TableViewMenu
            columns={PROJECT_DEFAULT_COLUMNS}
            onToggle={(column) =>
              setVisibility((current) => ({
                ...current,
                [column]: current[column] === false,
              }))
            }
            visibility={visibility}
          />
        </div>
        <div className="flex-1 overflow-auto">
          {/* Real component: `ProjectsTable`, unmodified. Its empty-state
              "Create Project" action shares the SAME open state as the modal
              below, exactly as `page.tsx` wires the two together. */}
          <ProjectsTable
            onCreateProject={() => setCreateOpen(true)}
            onDelete={fn()}
            onUpdateAssignee={fn()}
            onUpdatePriority={fn()}
            onUpdateStatus={fn()}
            onUpdateTargetDate={fn()}
            projects={projects}
            teamId={TEAM_ID}
            visibleColumns={visibleColumns}
          />
        </div>
      </div>

      {/* Real component: `CreateProjectModal`, unmodified, fully controlled
          rather than mocked out — clicking its own "Add Project" trigger,
          the empty-state action above, Cancel and the real submit flow all
          work. Production seats this trigger inside the app's `Header`
          component, which this hand-composed page does not mount (see
          dashboard.stories.tsx / settings.stories.tsx for why the app's own
          route chrome stays out of these Surface compositions); pinned to the
          same corner instead. */}
      <div className="fixed top-3 right-4 z-10">
        <CreateProjectModal
          onCreateProject={fn()}
          onOpenChange={setCreateOpen}
          open={createOpen}
          teamId={TEAM_ID}
          teamName={TEAM_NAME}
        />
      </div>
    </AppScreenShell>
  );
};

/**
 * The Projects listing at `/teams/<teamId>/projects`, showing every real
 * status, priority (including unset), and assignment state the table renders.
 */
const meta = {
  title: "Surfaces v1.0/Projects/Listing",
  component: ProjectsListingScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    projects: {
      description:
        "Rows the real ProjectsTable renders. Not a live control — the object is too structured for the Controls panel; switch between the named stories below instead.",
      table: { disable: true },
    },
    createModalOpen: {
      control: "boolean",
      description:
        "Pre-opens the real CreateProjectModal so its fields render without a click. Only read once, as this story's initial state.",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "",
    projects: PROJECTS,
  },
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, iframeHeight: 900 } },
    appCore: {
      queryData: [
        [userKeys.organizationUsers(), ORG_USERS],
        [userKeys.currentUser(), MORDECAI],
        [teamKeys.members(TEAM_ID), TEAM_MEMBERS],
        // ProjectsTable's row-favorite star (useIsFavorite) reads this
        // unconditionally; unseeded, the harness's fixture transport falls
        // back to an unmatched-GET default of `{}`, and `favorites?.some(...)`
        // throws on the missing array (`.data` exists, isn't an array).
        [projectKeys.favorites(), []],
      ],
    },
  },
} satisfies Meta<typeof ProjectsListingScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A brand new team, before anyone has created a project. Real `ProjectsTable`
 * empty state, with its own "Create Project" action wired to the same real
 * `CreateProjectModal` as every other story here. */
export const NoProjects: Story = {
  name: "No projects",
  args: { projects: [] },
};

/** The real `CreateProjectModal` pre-opened, so its live name/description/
 * priority/target-date/assignee fields render directly on the Docs page
 * without a click. */
export const CreateProjectOpen: Story = {
  name: "Create Project modal open",
  args: { createModalOpen: true },
};
