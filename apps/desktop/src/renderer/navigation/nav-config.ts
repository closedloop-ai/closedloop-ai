import {
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  CalendarClockIcon,
  ClipboardListIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  ScanSearchIcon,
  SettingsIcon,
  ShieldIcon,
  StethoscopeIcon,
} from "lucide-react";
import { NavId } from "./route-table";

/**
 * Sidebar nav sections. One runtime source of truth (a PascalCase const object)
 * per the repo's contract-value rule, so entries, display logic, labels, and the
 * Sidebar reference `NavSection.Account` instead of repeating the literal.
 */
export const NavSection = {
  Main: "main",
  Artifacts: "artifacts",
  Gateway: "gateway",
  Labs: "labs",
  Account: "account",
} as const;
export type NavSection = (typeof NavSection)[keyof typeof NavSection];

export type NavEntry = {
  id: NavId;
  label: string;
  icon: LucideIcon;
  section: NavSection;
};

/**
 * Sidebar nav model for the Desktop renderer, mirroring the web GlobalSidebar
 * layout (top-level, Artifacts, Gateway, Labs). Drives both the Sidebar and the
 * Topbar breadcrumb so labels stay in sync. Sessions and Dashboard are distinct
 * pages: Sessions hosts the agent-session list; Dashboard is a placeholder.
 */
export const NAV_ENTRIES: NavEntry[] = [
  {
    id: NavId.Dashboard,
    label: "Dashboard",
    icon: LayoutDashboardIcon,
    section: NavSection.Main,
  },
  {
    id: NavId.Sessions,
    label: "Sessions",
    icon: HistoryIcon,
    section: NavSection.Artifacts,
  },
  {
    id: NavId.Branches,
    label: "Branches",
    icon: GitBranchIcon,
    section: NavSection.Artifacts,
  },
  {
    // ISS-5310: Agents moved BACK into Labs (it was a top-level Artifacts entry,
    // and a FOCUS_MODE focus page on top of that). It is now an ordinary Labs
    // destination gated twice — by the `labsNav` container flag like every other
    // Labs item, and by its own per-item `agentsNav` flag inside it (see
    // `use-nav-gates.ts`). Both must be on for the entry or `#/agents` to appear.
    id: NavId.Agents,
    label: "Agents",
    icon: BotIcon,
    section: NavSection.Labs,
  },
  {
    // FEA-4087: the top-level Packs page — org-distributed + installable packs,
    // capability-driven (team vs solo). Mirrors the web sidebar's Packs entry
    // (PackageIcon). ISS-5310 moved Agents to Labs and deliberately left Packs
    // declared under Artifacts: the ticket scopes the move to Agents, and Packs
    // has no per-item flag of its own to gate it with. FOCUS_MODE folds Packs
    // into Labs like the other non-focus pages, so with FOCUS_MODE on the two
    // still DISPLAY together — the co-location is now incidental, not declared.
    id: NavId.Packs,
    label: "Packs",
    icon: PackageIcon,
    section: NavSection.Artifacts,
  },
  {
    id: NavId.Insights,
    label: "Insights",
    icon: BarChart3Icon,
    section: NavSection.Labs,
  },
  {
    // FEA-3989: nav label ↔ page heading alignment — the view's <h1> and this
    // entry both read "Audit Bot" (the product name), derived from this label
    // via pageTitleForNav so they cannot drift.
    id: NavId.Audit,
    label: "Audit Bot",
    icon: ScanSearchIcon,
    section: NavSection.Labs,
  },
  {
    id: NavId.Plans,
    label: "Plans",
    icon: ClipboardListIcon,
    section: NavSection.Labs,
  },
  {
    // PRD-566 / FEA-4348: Routines (the renamed "Scheduled Tasks" feature).
    // App.tsx hides it from the sidebar unless the `routines` flag is on (see
    // `hiddenNavIds`), mirroring how Audit/Help gate on their flags.
    id: NavId.Routines,
    label: "Routines",
    icon: CalendarClockIcon,
    section: NavSection.Labs,
  },
  {
    id: NavId.Approvals,
    label: "Approvals",
    icon: ShieldIcon,
    section: NavSection.Gateway,
  },
  {
    id: NavId.Requests,
    label: "Requests",
    icon: InboxIcon,
    section: NavSection.Gateway,
  },
  {
    // ISS-4478: Settings + Diagnostics surface from the bottom-left org/account
    // menu (the footer identity control), mirroring how web's AccountMenu hosts
    // its Settings link — not as a top-level sidebar nav group. The account
    // section is rendered by the footer AccountMenu, so these are excluded from
    // the FOCUS_MODE Labs fold below. Settings is listed first because it is what
    // people are actually looking for; Diagnostics is a troubleshooting page.
    id: NavId.Settings,
    label: "Settings",
    icon: SettingsIcon,
    section: NavSection.Account,
  },
  {
    id: NavId.Diagnostics,
    label: "Diagnostics",
    icon: StethoscopeIcon,
    section: NavSection.Account,
  },
  // FEA-3844 / PRD-555 M2: in-app Help (two-pane docs reader). Declared under
  // Labs; App.tsx hides it from the sidebar unless the `docsHelp` Labs flag is
  // on (see `hiddenNavIds`), mirroring how Agents gates on its flag.
  {
    id: NavId.Help,
    label: "Help",
    icon: BookOpenIcon,
    section: NavSection.Labs,
  },
];

export const NAV_SECTION_LABELS: Record<NavSection, string | null> = {
  [NavSection.Main]: null,
  [NavSection.Artifacts]: "Artifacts",
  [NavSection.Gateway]: "Gateway",
  [NavSection.Labs]: "Labs",
  // ISS-4478: account-menu destinations (Settings, Diagnostics) have no sidebar
  // section header. Their breadcrumb shows just the page label, mirroring web,
  // where Settings — reached from the AccountMenu — carries no section crumb.
  [NavSection.Account]: null,
};

export function navEntryFor(id: NavId): NavEntry | undefined {
  return NAV_ENTRIES.find((entry) => entry.id === id);
}

/**
 * FEA-3989: the single source of truth for a destination's display name. The
 * page <h1> and the Topbar breadcrumb must both name the same thing, so every
 * view derives its PageShell `title` from this helper instead of hardcoding a
 * string that can drift from the nav label. `navEntryFor` never returns
 * undefined for a NavId member (NAV_ENTRIES covers every id), but we fall back
 * to the raw id defensively so a missing entry degrades to a visible label
 * rather than an empty heading.
 */
export function pageTitleForNav(id: NavId): string {
  return navEntryFor(id)?.label ?? id;
}

/**
 * Temporary focus mode (week of 2026-06-15, per CEO directive): narrow the
 * top-level nav to the focus pages — Dashboard, Sessions and Branches — and fold
 * every other destination into the collapsible Labs section so the team stays
 * focused on those pages. Dashboard is the local-first overview / first
 * launch landing; the focus pages render in the unlabeled top group (`main`).
 *
 * Two sections are permanent exceptions and are NEVER folded into Labs:
 * - `account` (Settings, Diagnostics) always renders from the footer AccountMenu.
 * - `gateway` (Approvals, Requests) are live queues that stay in their own
 *   visible group — a queue buried behind a collapsed Labs section is a queue
 *   nobody checks (ISS-4478 review).
 *
 * NAV_ENTRIES above is the full nav and is preserved verbatim. To restore it,
 * set FOCUS_MODE to false and change nothing else. navItemsForSection() and
 * navSectionFor() are the only readers of this flag.
 */
export const FOCUS_MODE = true;

/**
 * Nav ids shown in the top-level group while FOCUS_MODE is on.
 *
 * ISS-5310 removed Agents from this list. It had been a top-level focus page
 * (FEA-2923, a Mike-approved focus-mode exception), which meant FOCUS_MODE
 * displayed it under `main` no matter what `section` it declared — so moving it
 * to `section: NavSection.Labs` alone would have changed nothing on screen.
 * Dropping it here is what actually puts it in Labs; both edits are load-bearing.
 */
const FOCUSED_NAV_IDS: readonly NavId[] = [
  NavId.Dashboard,
  NavId.Sessions,
  NavId.Branches,
];

/**
 * Sections that keep their declared placement even under FOCUS_MODE, instead of
 * folding into Labs like the other non-focus pages:
 * - `account` (Settings, Diagnostics) is always rendered from the footer
 *   AccountMenu, never as a sidebar nav group.
 * - `gateway` (Approvals, Requests) are live queues that must stay in their own
 *   visible group (ISS-4478 review).
 */
const FOCUS_MODE_EXEMPT_SECTIONS: readonly NavSection[] = [
  NavSection.Account,
  NavSection.Gateway,
];

/**
 * The section an entry is displayed under, honoring FOCUS_MODE. In focus mode
 * the focus pages render in the top-level group (`main`) and everything else is
 * shown in Labs, except the FOCUS_MODE-exempt sections, which keep their
 * declared section; otherwise the entry's declared section is used.
 */
function displaySection(entry: NavEntry): NavSection {
  if (FOCUS_MODE_EXEMPT_SECTIONS.includes(entry.section)) {
    return entry.section;
  }
  if (!FOCUS_MODE) {
    return entry.section;
  }
  return FOCUSED_NAV_IDS.includes(entry.id) ? NavSection.Main : NavSection.Labs;
}

/** Entries displayed under a section, honoring FOCUS_MODE. Preserves array order. */
export function navItemsForSection(section: NavSection): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => displaySection(entry) === section);
}

/** The displayed section for a nav id (drives the Topbar breadcrumb). */
export function navSectionFor(id: NavId): NavSection | undefined {
  const entry = navEntryFor(id);
  return entry ? displaySection(entry) : undefined;
}
