import type {
  ProjectSummaryOwner,
  ProjectSummaryRow,
} from "@repo/app/projects/lib/project-summary-row";

// ---------------------------------------------------------------------------
// Sidebar navigation model
// ---------------------------------------------------------------------------

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

export type NavIconName =
  | "dashboard"
  | "inbox"
  | "my-issues"
  | "documents"
  | "issues"
  | "sessions"
  | "branches"
  | "agents"
  | "insights"
  | "agent-monitoring"
  | "judges";

export type TeamFavorite = {
  id: string;
  name: string;
};

export type TeamItem = {
  id: string;
  name: string;
  isActive?: boolean;
  favorites?: readonly TeamFavorite[];
};

export const primaryNav: readonly NavItem[] = [
  { label: "Dashboard", icon: "dashboard" },
  { label: "Inbox", icon: "inbox", count: 8 },
  { label: "My Issues", icon: "my-issues" },
];

export const artifactsNav: readonly NavItem[] = [
  { label: "Documents", icon: "documents" },
  { label: "Issues", icon: "issues" },
  { label: "Sessions", icon: "sessions" },
  { label: "Branches", icon: "branches" },
  { label: "Agentic Components", icon: "agents" },
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  {
    id: "team-closedloop",
    name: "ClosedLoop",
    isActive: true,
    favorites: [
      { id: "fav-sprint-0810", name: "8/10-14" },
      { id: "fav-sprint-0817", name: "8/17-21" },
      {
        id: "fav-ottilie-august",
        name: "Ottilie August Strategic Projects",
      },
    ],
  },
  { id: "team-platform", name: "Platform Engineering" },
  { id: "team-pe-test", name: "PE TEST" },
];

export const labsNav: readonly NavItem[] = [
  { label: "Insights", icon: "insights" },
  { label: "Agent Monitoring", icon: "agent-monitoring" },
  { label: "Judges", icon: "judges" },
];

// ---------------------------------------------------------------------------
// Projects list model
// ---------------------------------------------------------------------------

/**
 * ISS-10476 promoted the Projects surface into `@repo/app`; the kit page is now
 * a fixture host for it, so the row shape is the portable one rather than a
 * second declaration of the same fields.
 */
export type Owner = ProjectSummaryOwner;
export type ProjectRow = ProjectSummaryRow;

const kait = owner("Kait Carb", "KC");
const ottilie = owner("Ottilie Eya", "AE");
const daveth = owner("Daveth Ortiz", "DO");
const marisol = owner("Marisol Angus", "MA");

/** Fixed clock this fixture's "N days ago" labels are written against. */
const KIT_REFERENCE_NOW_MS = Date.parse("2026-06-27T12:00:00Z");
const KIT_DAY_MS = 24 * 60 * 60 * 1000;

export const projects: readonly ProjectRow[] = [
  project({
    childTaskCount: 18,
    code: "PRO-1",
    completionPercentage: 45,
    dueDate: "Apr 28, 2026",
    id: "pro-1",
    name: "4/24 - Reduce Onboarding Friction",
    owner: kait,
    priority: "HIGH",
    updatedDaysAgo: 5,
  }),
  project({
    childTaskCount: 24,
    code: null,
    completionPercentage: 70,
    dueDate: "Jun 29, 2026",
    id: "pro-1-public-launch",
    name: "6/29 - Public Launch",
    owner: kait,
    priority: "LOW",
    updated: "Jun 22, 2026",
  }),
  project({
    childTaskCount: 9,
    code: "PRO-36",
    completionPercentage: 100,
    id: "pro-36",
    name: "6/29-7/2",
    owner: kait,
    priority: "MEDIUM",
    updated: "Jun 22, 2026",
  }),
  project({
    childTaskCount: 0,
    code: "PRO-32",
    completionPercentage: null,
    id: "pro-32",
    name: "7/8-10",
    owner: kait,
    priority: "MEDIUM",
    updatedDaysAgo: 1,
    updatedLabel: "Yesterday",
  }),
  project({
    childTaskCount: 6,
    code: null,
    completionPercentage: 0,
    id: "anouk-workspace",
    name: "Anouk Workspace",
    owner: ottilie,
    priority: "MEDIUM",
    updated: "Mar 12, 2026",
  }),
  project({
    childTaskCount: 14,
    code: null,
    completionPercentage: 20,
    id: "andrews-backlog",
    name: "Ottilie's Backlog",
    owner: ottilie,
    priority: "LOW",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 3,
    code: null,
    completionPercentage: 45,
    id: "archive",
    name: "Archive",
    owner: null,
    priority: "LOW",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 21,
    code: "PRO-33",
    completionPercentage: 70,
    id: "pro-33",
    name: "Bigs Backlog",
    owner: kait,
    priority: "MEDIUM",
    updated: "Jun 8, 2026",
  }),
  project({
    childTaskCount: 11,
    code: null,
    completionPercentage: 20,
    id: "daniels-workspace",
    name: "Daveth's Workspace",
    owner: daveth,
    priority: "MEDIUM",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 30,
    code: "PRO-3",
    completionPercentage: 45,
    id: "pro-3",
    name: "Enterprise",
    owner: marisol,
    priority: "HIGH",
    updated: "Mar 1, 2026",
  }),
  project({
    childTaskCount: 7,
    code: null,
    completionPercentage: 0,
    id: "entire-hq-gap-close",
    name: "Entire HQ Gap Close",
    owner: kait,
    priority: "LOW",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 16,
    code: null,
    completionPercentage: 45,
    id: "hosted-must-have",
    name: "Hosted Version + Free Trial - Must Have",
    owner: kait,
    priority: "MEDIUM",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 12,
    code: null,
    completionPercentage: 20,
    id: "hosted-nice-to-have",
    name: "Hosted Version + Free Trial - Nice To Have",
    owner: kait,
    priority: "LOW",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 19,
    code: null,
    completionPercentage: 70,
    id: "hosted-public-launch",
    name: "Hosted Version + Free Trial - Public Launch",
    owner: kait,
    priority: "MEDIUM",
    updated: "Mar 10, 2026",
  }),
  project({
    childTaskCount: 5,
    code: null,
    completionPercentage: 100,
    id: "idea-backlog-processed",
    name: "Idea Backlog (Processed)",
    owner: kait,
    priority: "LOW",
    updated: "Mar 5, 2026",
  }),
  project({
    childTaskCount: 13,
    code: "PRO-9",
    completionPercentage: 45,
    id: "ideas-triage",
    name: "Ideas Triage",
    owner: kait,
    priority: "MEDIUM",
    updated: "Apr 13, 2026",
  }),
];

function owner(name: string, initials: string): Owner {
  return { initials, name };
}

function project(input: {
  childTaskCount: number;
  code: string | null;
  completionPercentage: number | null;
  dueDate?: string | null;
  id: string;
  name: string;
  owner: Owner | null;
  priority: ProjectRow["priority"];
  updated?: string;
  updatedDaysAgo?: number;
  updatedLabel?: string;
}): ProjectRow {
  const updatedAtMs =
    input.updatedDaysAgo === undefined
      ? Date.parse(input.updated ?? "")
      : KIT_REFERENCE_NOW_MS - input.updatedDaysAgo * KIT_DAY_MS;
  const updatedLabel =
    input.updatedLabel ?? input.updated ?? `${input.updatedDaysAgo} days ago`;
  return {
    childTaskCount: input.childTaskCount,
    code: input.code,
    completionPercentage: input.completionPercentage,
    dueDateLabel: input.dueDate ?? null,
    dueDateMs: input.dueDate ? Date.parse(input.dueDate) : null,
    id: input.id,
    name: input.name,
    owner: input.owner,
    priority: input.priority,
    updatedAtMs,
    updatedLabel,
  };
}
