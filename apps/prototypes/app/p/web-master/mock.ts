// Sidebar navigation model for the Web Master demo shell. Mirrors the nav
// mocks in the blessed Sessions/Branches prototypes, except items whose
// surface exists as a subpage of this master carry a real href; active state
// is derived from the current pathname in the sidebar, not baked into the
// mock. The combined surfaces themselves are imported from their blessed
// prototype folders (app/p/sessions, app/p/branches) — no data is duplicated
// here.

export const WEB_MASTER_BASE_PATH = "/p/web-master";

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  /** Present when the item navigates to a subpage of this master prototype. */
  href?: string;
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

export type TeamFavorite = { id: string; name: string };

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
  {
    label: "Sessions",
    icon: "sessions",
    href: `${WEB_MASTER_BASE_PATH}/sessions`,
  },
  {
    label: "Branches",
    icon: "branches",
    href: `${WEB_MASTER_BASE_PATH}/branches`,
  },
  { label: "Agents", icon: "agents" },
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  {
    id: "team-closedloop",
    name: "ClosedLoop",
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
