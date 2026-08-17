// ---------------------------------------------------------------------------
// Desktop sidebar navigation model
//
// Mirrors the Electron renderer's nav-config in FOCUS_MODE: a flat top-level
// group (Dashboard / Sessions / Branches) plus a collapsible "Labs" section
// that folds everything else. The Gateway footer replaces the web app's
// Compute + Account footer rows.
// ---------------------------------------------------------------------------

export type NavIconName =
  | "dashboard"
  | "sessions"
  | "branches"
  | "agents"
  | "insights"
  | "plans"
  | "approvals"
  | "requests"
  | "diagnostics"
  | "settings";

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

// Top-level focus pages — rendered in the unlabeled group at the top of the
// sidebar, matching the desktop screenshot.
export const mainNav: readonly NavItem[] = [
  { label: "Dashboard", icon: "dashboard" },
  { label: "Sessions", icon: "sessions", isActive: true },
  { label: "Branches", icon: "branches" },
];

// Everything else folds into the collapsible Labs section.
export const labsNav: readonly NavItem[] = [
  { label: "Insights", icon: "insights" },
  { label: "Plans", icon: "plans" },
  { label: "Approvals", icon: "approvals" },
  { label: "Requests", icon: "requests", count: 3 },
  { label: "Diagnostics", icon: "diagnostics" },
  { label: "Settings", icon: "settings" },
];

// ---------------------------------------------------------------------------
// Sessions list model
//
// Mirrors the desktop Sessions page (SessionsView + the shared SessionsTable):
// a leading Session Name column plus Status / Autonomy / Repository / Branch /
// PR data columns. Values are display-ready, matching the real page's
// presentational row shape.
// ---------------------------------------------------------------------------

export const SessionStatus = {
  Active: "active",
  Completed: "completed",
} as const;

export type SessionStatusValue =
  (typeof SessionStatus)[keyof typeof SessionStatus];

export type SessionRow = {
  id: string;
  name: string;
  status: SessionStatusValue;
  /** Renders the accent "Awaiting input" badge beside the name. */
  awaitingInput?: boolean;
  /** Autonomy score 0–100; null when the session carries no metric. */
  autonomy: number | null;
  repo: string | null;
  branch: string | null;
  pr: string | null;
};

// Time window covered by the summary totals (matches the 30d selection).
export const SESSIONS_DATE_RANGE_LABEL = "Jun 15 – Jul 15, 2026";
export const TOTAL_SESSIONS = 328;
export const TOTAL_TOKENS = 19_593_367;
export const SESSIONS_TOTAL_PAGES = 14;

const REPO_SYMPHONY = "closedloop-ai/symphony";
const REPO_LYON = "lyon";

export const sessions: readonly SessionRow[] = [
  {
    id: "b23d7b7b-f679-4b98",
    name: "b23d7b7b-f679-4b98-bfb9-a2ca0b86c5b8",
    status: SessionStatus.Active,
    awaitingInput: true,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "53e0bcc3-6cf7-4d7f",
    name: "53e0bcc3-6cf7-4d7f-8829-1b0d2f7a90ab",
    status: SessionStatus.Active,
    awaitingInput: true,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "615edc64-43f3-45f5",
    name: "615edc64-43f3-45f5-af6b-964efdd0b761",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "d7b3f421-6ca4-46ab",
    name: "d7b3f421-6ca4-46ab-b0fd-ce614db7b3dd",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "0c51d94a-c6cc-4fda",
    name: "0c51d94a-c6cc-4fda-aa39-92ae540973f9",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "506131fb-7a86-4038",
    name: "506131fb-7a86-4038-8829-5841c2f1ecbc",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_LYON,
    branch: null,
    pr: null,
  },
  {
    id: "cahokia-98e6c15c",
    name: "cahokia - 98e6c15c",
    status: SessionStatus.Completed,
    autonomy: 100,
    repo: REPO_SYMPHONY,
    branch: "parkerbyrd-ux/plugins-prototype",
    pr: null,
  },
  {
    id: "57e44843-088a-4298",
    name: "57e44843-088a-4298-9aad-c7681cc8f4d2",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_LYON,
    branch: null,
    pr: null,
  },
  {
    id: "12d72249-d075-4a34",
    name: "12d72249-d075-4a34-ad47-3019d48d7f61",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "a41f9c02-2db8-4e77",
    name: "a41f9c02-2db8-4e77-9c1a-6f0b5d3e21cc",
    status: SessionStatus.Completed,
    autonomy: 72,
    repo: REPO_SYMPHONY,
    branch: "parkerbyrd-ux/setup-logs-review",
    pr: "#2881",
  },
  {
    id: "e9b7a530-4c61-42af",
    name: "e9b7a530-4c61-42af-88d5-0a2e7c94ba10",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "3f6c1d84-9a20-4b13",
    name: "3f6c1d84-9a20-4b13-a7e2-15c8d0f4e9a7",
    status: SessionStatus.Completed,
    autonomy: 45,
    repo: REPO_LYON,
    branch: null,
    pr: null,
  },
  {
    id: "7d2e0b95-8f43-4c6a",
    name: "7d2e0b95-8f43-4c6a-b0d1-92ff3a1e6c48",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_SYMPHONY,
    branch: null,
    pr: null,
  },
  {
    id: "c8a4f712-6b39-4d20",
    name: "c8a4f712-6b39-4d20-9e51-4b7a2c0d8f36",
    status: SessionStatus.Completed,
    autonomy: 88,
    repo: REPO_SYMPHONY,
    branch: "parkerbyrd-ux/packs-domain",
    pr: "#2877",
  },
  {
    id: "1b5d9e60-2a17-48c3",
    name: "1b5d9e60-2a17-48c3-8f74-6d0e5a3b9271",
    status: SessionStatus.Completed,
    autonomy: null,
    repo: REPO_LYON,
    branch: null,
    pr: null,
  },
];

/** Compact autonomy label bucket, mirroring the app's getAutonomyShortLabel. */
export function autonomyShortLabel(score: number): string {
  if (score >= 80) {
    return "High";
  }
  if (score >= 50) {
    return "Medium";
  }
  return "Low";
}
