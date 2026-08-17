import type { PriorityLevel } from "@repo/design-system/components/ui/priority-icon";

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
  | "loops"
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
  { label: "Agents", icon: "agents" },
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  {
    id: "team-closedloop",
    name: "ClosedLoop",
    isActive: true,
    favorites: [
      { id: "fav-night-crew", name: "Night Crew" },
      { id: "fav-parker-triage", name: "Parker Triage" },
      { id: "fav-sprint", name: "6/29-7/2" },
    ],
  },
  { id: "team-platform", name: "Platform Engineering" },
  { id: "team-pe-test", name: "PE TEST" },
];

export const labsNav: readonly NavItem[] = [
  { label: "Insights", icon: "insights" },
  { label: "Loops", icon: "loops" },
  { label: "Agent Monitoring", icon: "agent-monitoring" },
  { label: "Judges", icon: "judges" },
];

// ---------------------------------------------------------------------------
// Projects list model
// ---------------------------------------------------------------------------

export type Assignee = {
  name: string;
  initials: string;
  accent: string;
};

export type ProjectRow = {
  id: string;
  code: string | null;
  name: string;
  priority: PriorityLevel;
  assignee: Assignee | null;
  dueDate: string | null;
  updated: string;
  depth?: number;
};

const kait: Assignee = { name: "Kait Carb", initials: "KC", accent: "#f59e0b" };
const andrew: Assignee = {
  name: "Andrew Eya",
  initials: "AE",
  accent: "#6366f1",
};
const daniel: Assignee = {
  name: "Daniel Ortiz",
  initials: "DO",
  accent: "#0ea5e9",
};
const mike: Assignee = {
  name: "Mike Angus",
  initials: "MA",
  accent: "#10b981",
};

export const projects: readonly ProjectRow[] = [
  {
    id: "pro-1",
    code: "PRO-1",
    name: "4/24 - Reduce Onboarding Friction",
    priority: "HIGH",
    assignee: kait,
    dueDate: "Apr 28, 2026",
    updated: "5 days ago",
  },
  {
    id: "pro-1-public-launch",
    code: null,
    name: "6/29 - Public Launch",
    priority: "LOW",
    assignee: kait,
    dueDate: "Jun 29, 2026",
    updated: "Jun 22, 2026",
    depth: 1,
  },
  {
    id: "pro-36",
    code: "PRO-36",
    name: "6/29-7/2",
    priority: "MEDIUM",
    assignee: kait,
    dueDate: null,
    updated: "Jun 22, 2026",
  },
  {
    id: "pro-32",
    code: "PRO-32",
    name: "7/8-10",
    priority: "MEDIUM",
    assignee: kait,
    dueDate: null,
    updated: "Yesterday",
  },
  {
    id: "adam-workspace",
    code: null,
    name: "Adam Workspace",
    priority: "MEDIUM",
    assignee: andrew,
    dueDate: null,
    updated: "Mar 12, 2026",
  },
  {
    id: "andrews-backlog",
    code: null,
    name: "Andrew's Backlog",
    priority: "LOW",
    assignee: andrew,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "archive",
    code: null,
    name: "Archive",
    priority: "LOW",
    assignee: null,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "pro-33",
    code: "PRO-33",
    name: "Bigs Backlog",
    priority: "MEDIUM",
    assignee: kait,
    dueDate: null,
    updated: "Jun 8, 2026",
  },
  {
    id: "daniels-workspace",
    code: null,
    name: "Daniel's Workspace",
    priority: "MEDIUM",
    assignee: daniel,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "pro-3",
    code: "PRO-3",
    name: "Enterprise",
    priority: "HIGH",
    assignee: mike,
    dueDate: null,
    updated: "Mar 1, 2026",
  },
  {
    id: "entire-hq-gap-close",
    code: null,
    name: "Entire HQ Gap Close",
    priority: "LOW",
    assignee: kait,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "hosted-must-have",
    code: null,
    name: "Hosted Version + Free Trial - Must Have",
    priority: "MEDIUM",
    assignee: kait,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "hosted-nice-to-have",
    code: null,
    name: "Hosted Version + Free Trial - Nice To Have",
    priority: "LOW",
    assignee: kait,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "hosted-public-launch",
    code: null,
    name: "Hosted Version + Free Trial - Public Launch",
    priority: "MEDIUM",
    assignee: kait,
    dueDate: null,
    updated: "Mar 10, 2026",
  },
  {
    id: "idea-backlog-processed",
    code: null,
    name: "Idea Backlog (Processed)",
    priority: "LOW",
    assignee: kait,
    dueDate: null,
    updated: "Mar 5, 2026",
  },
  {
    id: "ideas-triage",
    code: "PRO-9",
    name: "Ideas Triage",
    priority: "MEDIUM",
    assignee: kait,
    dueDate: null,
    updated: "Apr 13, 2026",
  },
];
