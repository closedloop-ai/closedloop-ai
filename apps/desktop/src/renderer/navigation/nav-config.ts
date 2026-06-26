import {
  ActivityIcon,
  BarChart3Icon,
  BotIcon,
  ClipboardListIcon,
  CopyCheckIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  StethoscopeIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { NavId } from "./route-table";

export type NavSection = "main" | "artifacts" | "gateway" | "labs";

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
    section: "main",
  },
  {
    id: NavId.Kanban,
    label: "My Issues",
    icon: CopyCheckIcon,
    section: "main",
  },
  {
    id: NavId.Sessions,
    label: "Sessions",
    icon: HistoryIcon,
    section: "artifacts",
  },
  {
    id: NavId.Branches,
    label: "Branches",
    icon: GitBranchIcon,
    section: "artifacts",
  },
  {
    id: NavId.Activity,
    label: "Activity",
    icon: ActivityIcon,
    section: "labs",
  },
  {
    id: NavId.Insights,
    label: "Insights",
    icon: BarChart3Icon,
    section: "labs",
  },
  {
    id: NavId.Workflows,
    label: "Workflows",
    icon: WorkflowIcon,
    section: "labs",
  },
  { id: NavId.Packs, label: "Packs", icon: PackageIcon, section: "labs" },
  { id: NavId.Skills, label: "Skills", icon: SparklesIcon, section: "labs" },
  { id: NavId.Tools, label: "Tools", icon: WrenchIcon, section: "labs" },
  { id: NavId.Subagents, label: "SubAgents", icon: BotIcon, section: "labs" },
  { id: NavId.Plans, label: "Plans", icon: ClipboardListIcon, section: "labs" },
  {
    id: NavId.PullRequests,
    label: "Pull Requests",
    icon: GitPullRequestIcon,
    section: "labs",
  },
  {
    id: NavId.Approvals,
    label: "Approvals",
    icon: ShieldIcon,
    section: "gateway",
  },
  {
    id: NavId.Requests,
    label: "Requests",
    icon: InboxIcon,
    section: "gateway",
  },
  {
    id: NavId.Diagnostics,
    label: "Diagnostics",
    icon: StethoscopeIcon,
    section: "gateway",
  },
  {
    id: NavId.Settings,
    label: "Settings",
    icon: SettingsIcon,
    section: "gateway",
  },
];

export const NAV_SECTION_LABELS: Record<NavSection, string | null> = {
  main: null,
  artifacts: "Artifacts",
  gateway: "Gateway",
  labs: "Labs",
};

export function navEntryFor(id: NavId): NavEntry | undefined {
  return NAV_ENTRIES.find((entry) => entry.id === id);
}

/**
 * Temporary focus mode (week of 2026-06-15, per CEO directive): narrow the
 * top-level nav to the focus pages — Dashboard, Sessions, and Branches — and
 * fold every other destination into the collapsible Labs section so the team
 * stays focused on those pages. Dashboard is the local-first overview / first
 * launch landing; the focus pages render in the unlabeled top group (`main`).
 *
 * NAV_ENTRIES above is the full nav and is preserved verbatim. To restore it,
 * set FOCUS_MODE to false and change nothing else. navItemsForSection() and
 * navSectionFor() are the only readers of this flag.
 */
export const FOCUS_MODE = true;

/** Nav ids shown in the top-level group while FOCUS_MODE is on. */
const FOCUSED_NAV_IDS: readonly NavId[] = [
  NavId.Dashboard,
  NavId.Sessions,
  NavId.Branches,
];

/**
 * The section an entry is displayed under, honoring FOCUS_MODE. In focus mode
 * the focus pages render in the top-level group (`main`) and everything else is
 * shown in Labs; otherwise the entry's declared section is used.
 */
function displaySection(entry: NavEntry): NavSection {
  if (!FOCUS_MODE) {
    return entry.section;
  }
  return FOCUSED_NAV_IDS.includes(entry.id) ? "main" : "labs";
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
