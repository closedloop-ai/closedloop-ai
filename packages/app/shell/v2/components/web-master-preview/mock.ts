// Sidebar navigation model for the Web Master demo shell. Mirrors the nav
// mocks in the blessed Sessions/Branches prototypes, except items whose
// surface exists as a subpage of this master carry a real href; active state
// is derived from the current pathname in the sidebar, not baked into the
// mock. The combined surfaces themselves are imported from their blessed
// prototype folders (app/p/sessions, app/p/branches); no data is duplicated
// here.

import { countNeedsAttention } from "../../../../inbox/components/web-master-preview/inbox-v2-model"; // Cross-slice: preview shell hosts the Inbox preview (ISS-12938).
import { seedThreads } from "../../../../inbox/components/web-master-preview/inbox-v2-threads"; // Cross-slice: preview shell hosts the Inbox preview (ISS-12938).

export const WEB_MASTER_BASE_PATH = "/p/web-master";

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  /** Marks a navigation entry that exists only to explain the prototype. */
  isPrototypeOnly?: boolean;
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
  | "approvals"
  | "requests"
  | "generic-artifact"
  | "prototypes";

export type TeamFavorite = { id: string; name: string; href: string };

export type TeamItem = {
  id: string;
  name: string;
  href?: string;
  isActive?: boolean;
  favorites?: readonly TeamFavorite[];
};

export const primaryNav: readonly NavItem[] = [
  {
    label: "Dashboard",
    icon: "dashboard",
    href: `${WEB_MASTER_BASE_PATH}/dashboard`,
  },
];

export const artifactsNav: readonly NavItem[] = [
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
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  {
    id: "team-closedloop",
    name: "ClosedLoop",
    href: `${WEB_MASTER_BASE_PATH}/projects`,
    favorites: [
      {
        id: "fav-sprint-0810",
        name: "8/10-14",
        href: `${WEB_MASTER_BASE_PATH}/projects/sprint-0810`,
      },
      {
        id: "fav-sprint-0817",
        name: "8/17-21",
        href: `${WEB_MASTER_BASE_PATH}/projects/sprint-0817`,
      },
      {
        id: "fav-ottilie-august",
        name: "Ottilie August Strategic Projects",
        href: `${WEB_MASTER_BASE_PATH}/projects/ottilie-august`,
      },
    ],
  },
  { id: "team-platform", name: "Platform Engineering" },
  { id: "team-pe-test", name: "PE TEST" },
];

export const labsNav: readonly NavItem[] = [
  {
    label: "Inbox",
    icon: "inbox",
    // Derived from the same threads and the same predicate the Inbox toolbar
    // counts, so the sidebar badge cannot contradict the badge on the page it
    // now links to.
    count: countNeedsAttention(seedThreads, []),
    href: `${WEB_MASTER_BASE_PATH}/inbox`,
  },
  { label: "My Issues", icon: "my-issues" },
  { label: "Insights", icon: "insights" },
  { label: "Approvals", icon: "approvals" },
  { label: "Requests", icon: "requests" },
];

export const labsArtifactsNav: readonly NavItem[] = [
  {
    label: "Generic Artifact",
    icon: "generic-artifact",
    href: `${WEB_MASTER_BASE_PATH}/generic-artifact`,
  },
  {
    label: "Documents",
    icon: "documents",
    href: `${WEB_MASTER_BASE_PATH}/documents`,
  },
  {
    label: "Issues",
    icon: "issues",
    href: `${WEB_MASTER_BASE_PATH}/issues`,
  },
  {
    label: "Issues v2",
    icon: "issues",
    href: `${WEB_MASTER_BASE_PATH}/issues-v2`,
  },
  {
    label: "Agents",
    icon: "agents",
    href: `${WEB_MASTER_BASE_PATH}/agents`,
  },
  {
    label: "Prototypes",
    icon: "prototypes",
    href: `${WEB_MASTER_BASE_PATH}/prototypes`,
  },
];

/**
 * Installer targets handed to the guided-onboarding download step.
 *
 * Producer for macOS: `getPublicDesktopReleaseDownloadUrl` in
 * `packages/api/src/types/desktop-release.ts` — the PUBLIC
 * `closedloop-ai/closedloop-ai` mirror. The same path on the private
 * `closedloop-ai` repo 404s for a new user, which is why no URL is baked into
 * the shared step.
 *
 * Windows and Linux have NO published installer today: `desktop-release.yml`
 * ships only `Closedloop-*-universal.dmg` and `-universal-mac.zip`. These two
 * entries are therefore a presumed future artifact, not a live target — whether
 * those CTAs should appear at all before such a build exists is an open product
 * question, not something this prototype decides.
 */
export const desktopInstallerHrefs = {
  linux:
    "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop.AppImage",
  mac: "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-universal.dmg",
  windows:
    "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-Setup.exe",
} as const;
