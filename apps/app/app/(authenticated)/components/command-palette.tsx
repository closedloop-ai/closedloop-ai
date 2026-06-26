"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import {
  AGENTS_FEATURE_FLAG_KEY,
  ArtifactFlag,
  JUDGES_FEATURE_FLAG_KEY,
  SESSIONS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import {
  BarChart3,
  BotIcon,
  CopyCheckIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  RotateCcwIcon,
  SquareCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * PostHog flag gating the global command palette (cmd+k / ctrl+k launcher).
 * First slice surfaces in apps/app only (FEA-2094); the component is built on
 * the cross-surface navigation port so it can later mount in the desktop
 * renderer unchanged.
 */
export const COMMAND_PALETTE_FEATURE_FLAG_KEY = "emergent";

type PaletteCommand = {
  /** Stable id used as the React key. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** Org-relative href (always starts with "/"); resolved via useOrgPath(). */
  href: string;
  /** Extra search terms so fuzzy matching finds the command by intent. */
  keywords?: string[];
  /** When set, the command is only listed if this flag is enabled. */
  featureFlag?: string;
};

// Mirrors the destinations the sidebar exposes (sidebar.tsx buildNavData) so the
// palette is a keyboard-first equivalent of clicking through the nav, with the
// same per-item feature-flag gating.
const NAVIGATION_COMMANDS: PaletteCommand[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    icon: LayoutDashboardIcon,
    href: "/dashboard",
    keywords: ["home", "overview"],
  },
  {
    id: "inbox",
    title: "Inbox",
    icon: InboxIcon,
    href: "/inbox",
    keywords: ["notifications"],
  },
  {
    id: "my-issues",
    title: "My Issues",
    icon: CopyCheckIcon,
    href: "/my-tasks",
    keywords: ["tasks", "assigned"],
  },
  {
    id: "documents",
    title: "Documents",
    icon: FileIcon,
    href: "/documents",
    keywords: ["prd", "plan", "feature", "artifact"],
    featureFlag: ArtifactFlag.Documents,
  },
  {
    id: "issues",
    title: "Issues",
    icon: SquareCheckIcon,
    href: "/issues",
    featureFlag: ArtifactFlag.Issues,
  },
  {
    id: "sessions",
    title: "Sessions",
    icon: HistoryIcon,
    href: "/sessions",
    keywords: ["agent", "runs"],
    featureFlag: SESSIONS_FEATURE_FLAG_KEY,
  },
  {
    id: "branches",
    title: "Branches",
    icon: GitBranchIcon,
    href: "/branches",
    keywords: ["pr", "pull request"],
    featureFlag: ArtifactFlag.Branches,
  },
  {
    id: "agents",
    title: "Agents",
    icon: BotIcon,
    href: "/agents",
    featureFlag: AGENTS_FEATURE_FLAG_KEY,
  },
  {
    id: "insights",
    title: "Insights",
    icon: BarChart3,
    href: "/insights",
    featureFlag: INSIGHTS_FEATURE_FLAG_KEY,
  },
  {
    id: "loops",
    title: "Loops",
    icon: RotateCcwIcon,
    href: "/loops",
    keywords: ["execution", "run"],
  },
  {
    id: "agent-monitoring",
    title: "Agent Monitoring",
    icon: BarChart3,
    href: "/loops/monitoring",
    keywords: ["telemetry", "analytics"],
    featureFlag: SESSIONS_FEATURE_FLAG_KEY,
  },
  {
    id: "judges",
    title: "Judges",
    icon: BarChart3,
    href: "/judges-analytics",
    keywords: ["evaluation", "quality"],
    featureFlag: JUDGES_FEATURE_FLAG_KEY,
  },
];

/**
 * Global command palette / quick-switcher (cmd+k, ctrl+k).
 *
 * Jumps to the primary org-scoped destinations, reusing the shadcn `ui/command`
 * primitive. Gated behind `emergent`: when the flag is off the component
 * renders nothing and registers no shortcut. Individual destinations are gated
 * by the same flags as the sidebar so the palette never links to a hidden
 * feature.
 */
export function CommandPalette() {
  const enabled =
    useFeatureFlag(COMMAND_PALETTE_FEATURE_FLAG_KEY)?.enabled === true;
  const [open, setOpen] = useState(false);
  const buildOrgPath = useOrgPath();
  const { navigate } = useNavigation();

  // Resolve every per-destination flag up front so the hook call order stays
  // stable across renders (rules-of-hooks); destinations are filtered below.
  const enabledByFlag: Record<string, boolean> = {
    [ArtifactFlag.Documents]:
      useFeatureFlag(ArtifactFlag.Documents)?.enabled === true,
    [ArtifactFlag.Issues]:
      useFeatureFlag(ArtifactFlag.Issues)?.enabled === true,
    [ArtifactFlag.Branches]:
      useFeatureFlag(ArtifactFlag.Branches)?.enabled === true,
    [SESSIONS_FEATURE_FLAG_KEY]:
      useFeatureFlag(SESSIONS_FEATURE_FLAG_KEY)?.enabled === true,
    [AGENTS_FEATURE_FLAG_KEY]:
      useFeatureFlag(AGENTS_FEATURE_FLAG_KEY)?.enabled === true,
    [INSIGHTS_FEATURE_FLAG_KEY]:
      useFeatureFlag(INSIGHTS_FEATURE_FLAG_KEY)?.enabled === true,
    [JUDGES_FEATURE_FLAG_KEY]:
      useFeatureFlag(JUDGES_FEATURE_FLAG_KEY)?.enabled === true,
  };

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  const runCommand = useCallback(
    (href: string) => {
      setOpen(false);
      navigate(buildOrgPath(href));
    },
    [navigate, buildOrgPath]
  );

  if (!enabled) {
    return null;
  }

  const visibleCommands = NAVIGATION_COMMANDS.filter(
    (command) =>
      command.featureFlag === undefined || enabledByFlag[command.featureFlag]
  );

  return (
    <CommandDialog
      description="Jump to a page"
      onOpenChange={setOpen}
      open={open}
      title="Command palette"
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Go to">
          {visibleCommands.map((command) => (
            <CommandItem
              key={command.id}
              keywords={command.keywords}
              onSelect={() => runCommand(command.href)}
              value={command.title}
            >
              <command.icon />
              <span>{command.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
