import {
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  ClipboardListIcon,
  FileTextIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  SettingsIcon,
  ShieldIcon,
  SquareCheckIcon,
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
 * layout (top-level, Artifacts, Labs). Drives both the Sidebar and the Topbar
 * breadcrumb so labels stay in sync. Sessions and Dashboard are distinct pages:
 * Sessions hosts the agent-session list; Dashboard is a placeholder.
 */
export const NAV_ENTRIES: NavEntry[] = [
  {
    // Documents and Issues lead the Artifacts group, ahead of Sessions and
    // Branches, each gated by its own key (see `use-nav-gates.ts`).
    id: NavId.Documents,
    label: "Documents",
    icon: FileTextIcon,
    section: NavSection.Artifacts,
  },
  {
    id: NavId.Issues,
    label: "Issues",
    icon: SquareCheckIcon,
    section: NavSection.Artifacts,
  },
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
    // (PackageIcon). ISS-5310 left Packs declared under Artifacts because
    // FOCUS_MODE folded it into Labs anyway, so the declaration had no visible
    // consequence. Operator direction 2026-09-04 exempts `artifacts` from that
    // fold, which WOULD have pulled Packs up into the restored Artifacts group,
    // so the declaration moves here, and Packs stays a Labs destination as
    // displayed.
    id: NavId.Packs,
    label: "Packs",
    icon: PackageIcon,
    section: NavSection.Labs,
  },
  {
    id: NavId.Insights,
    label: "Insights",
    icon: BarChart3Icon,
    section: NavSection.Labs,
  },
  {
    id: NavId.Plans,
    label: "Plans",
    icon: ClipboardListIcon,
    section: NavSection.Labs,
  },
  {
    // ISS-8759 (desktop mirror): Approvals and Requests declared their own
    // `gateway` section, which `FOCUS_MODE_EXEMPT_SECTIONS` then kept out of the
    // Labs fold. Operator direction 2026-09-03 moves the Gateway sub-menu under
    // Labs, matching what the shared shell contract has always said about them
    // (`ShellNavigationGroupId.Labs`), so the section they declare is now Labs
    // like every other non-focus page and `NavSection.Gateway` is gone.
    //
    // Consequence, stated rather than smuggled: a displayed Labs route is inside
    // the ISS-5037 `labsNav` container gate, so these two queues are hidden AND
    // unreachable while Labs is off. That is what "under Labs" means on desktop;
    // both now declare that gate in the shared shell contract.
    id: NavId.Approvals,
    label: "Approvals",
    icon: ShieldIcon,
    section: NavSection.Labs,
  },
  {
    id: NavId.Requests,
    label: "Requests",
    icon: InboxIcon,
    section: NavSection.Labs,
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
 * Temporary focus mode (week of 2026-06-15, per CEO directive): fold every
 * destination that is neither a focus page nor in a FOCUS_MODE-exempt section
 * into the collapsible Labs section, so the team stays focused. Dashboard is the
 * local-first overview / first launch landing and is the one focus page left
 * rendering in the unlabeled top group (`main`).
 *
 * The exempt sections — the ones that keep their declared placement — are listed
 * in FOCUS_MODE_EXEMPT_SECTIONS below. `gateway` used to be one: ISS-4478 review
 * kept Approvals/Requests in their own visible group so a live queue was not
 * buried behind a collapsed Labs section. Operator direction 2026-09-03 overrules
 * that placement (see NAV_ENTRIES), so that exemption, and the section itself,
 * are gone.
 *
 * NAV_ENTRIES above is NOT preserved verbatim under this flag: the 2026-09-04
 * Artifacts fix moved Packs' DECLARED section from `artifacts` to `labs` (see its
 * entry), so setting FOCUS_MODE to false no longer reproduces the pre-focus nav
 * byte for byte — Packs would stay in Labs, which is where the operator wants it.
 * navItemsForSection() and navSectionFor() are the only readers of this flag.
 */
export const FOCUS_MODE = true;

/**
 * Nav ids shown in the top-level group while FOCUS_MODE is on — but only for
 * entries that reach this list. `displaySection` consults
 * FOCUS_MODE_EXEMPT_SECTIONS FIRST, so an entry declaring an exempt section is
 * placed by its declaration and never resolved here. Since 2026-09-04 that
 * includes `artifacts`, so Dashboard is the only id this list actually decides
 * today. Sessions and Branches are retained because they are still the focus
 * pages: dropping the `artifacts` exemption must put them back in the top-level
 * group, not fold them into Labs.
 *
 * ISS-5310 removed Agents from this list. It had been a top-level focus page
 * (FEA-2923, a Marisol-approved focus-mode exception), which meant FOCUS_MODE
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
 * folding into Labs like the other non-focus pages. Two of them:
 *
 *   - `artifacts` (Documents, Issues, Sessions, Branches) renders as the
 *     "Artifacts" sidebar group,
 *     matching web's GlobalSidebar. Added 2026-09-04: without the exemption
 *     nothing could ever DISPLAY under `artifacts` — Sessions and Branches were
 *     forced into `main` by FOCUSED_NAV_IDS and everything else into Labs, so
 *     `navItemsForSection(NavSection.Artifacts)` returned [] and the Sidebar's
 *     `artifactItems.length > 0` guard dropped the group header entirely.
 *   - `account` (Settings, Diagnostics) is always rendered from the footer
 *     AccountMenu, never as a sidebar nav group.
 *
 * ISS-8759's desktop mirror folded `gateway` in with everything else and deleted
 * the section, so it is not one of them.
 */
const FOCUS_MODE_EXEMPT_SECTIONS: readonly NavSection[] = [
  NavSection.Artifacts,
  NavSection.Account,
];

/**
 * The section an entry is displayed under, honoring FOCUS_MODE. The exempt
 * check runs FIRST and wins over FOCUSED_NAV_IDS, so an entry declaring an
 * exempt section keeps that declaration whatever else says — which is why an
 * entry that must stay in Labs has to DECLARE `labs` rather than rely on the
 * fold. Otherwise, in focus mode the focus pages render in the top-level group
 * (`main`) and everything else is folded into Labs; with FOCUS_MODE off the
 * entry's declared section is used.
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
