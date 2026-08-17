"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import {
  ArtifactFlag,
  JUDGES_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
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
import { BarChart3, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
  /**
   * ISS-5037: a CONTAINER flag sitting ABOVE {@link featureFlag}. Set on the
   * destinations that live in the Labs sidebar section: with Labs off, the
   * route 404s through `FeatureFlagRouteGate`, so listing it here would offer a
   * keyboard jump to a dead end. Both flags must be on for the command to show.
   */
  containerFlag?: string;
};

// Palette-only fuzzy-search synonyms, keyed by the org-relative registry path.
// The visible title, icon, href, and flag come from PRIMARY_NAV_DESTINATIONS
// (the single source of truth the sidebar and mobile nav also derive from), so
// only these intent keywords are palette-specific — a path or gating change in
// the registry can no longer split cmd+k from the sidebar.
const PALETTE_KEYWORDS_BY_PATH: Record<string, string[]> = {
  "/dashboard": ["home", "overview"],
  "/inbox": ["notifications"],
  "/my-tasks": ["tasks", "assigned"],
  "/sessions": ["agent", "runs"],
  "/branches": ["pr", "pull request"],
  "/documents": ["docs"],
};

// The primary navigation commands, built from the shared registry so the palette
// stays a keyboard-first equivalent of the sidebar, with the same per-item
// feature-flag gating. Only palette-specific keywords are layered on here.
const PRIMARY_NAV_COMMANDS: PaletteCommand[] = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => ({
    id: destination.path,
    title: destination.title,
    icon: destination.icon,
    href: destination.path,
    keywords: PALETTE_KEYWORDS_BY_PATH[destination.path],
    featureFlag: destination.featureFlag,
  })
);

// Palette-only destinations that are NOT part of the primary nav registry
// (they have no mobile-nav entry), so they are declared here rather than
// derived. Kept flag-gated to match how each surface is reached elsewhere.
// ISS-5037: both live in the sidebar's Labs section, so both also carry the
// Labs container flag — the palette must not stay a back door into a section
// the sidebar has hidden and the route now 404s.
const PALETTE_EXTRA_COMMANDS: PaletteCommand[] = [
  {
    id: "insights",
    title: "Insights",
    icon: BarChart3,
    href: "/insights",
    featureFlag: INSIGHTS_FEATURE_FLAG_KEY,
    containerFlag: LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  },
  {
    id: "judges",
    title: "Judges",
    icon: BarChart3,
    href: "/judges-analytics",
    keywords: ["evaluation", "quality"],
    featureFlag: JUDGES_FEATURE_FLAG_KEY,
    containerFlag: LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  },
];

const NAVIGATION_COMMANDS: PaletteCommand[] = [
  ...PRIMARY_NAV_COMMANDS,
  ...PALETTE_EXTRA_COMMANDS,
];

/**
 * Global command palette / quick-switcher (cmd+k, ctrl+k).
 *
 * Jumps to the primary org-scoped destinations, reusing the shadcn `ui/command`
 * primitive. The palette itself is always available (ISS-4693 retired its
 * `emergent` gate); individual destinations are still gated by the same flags
 * as the sidebar so the palette never links to a hidden feature.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const buildOrgPath = useOrgPath();
  const { navigate } = useNavigation();

  // Resolve every per-destination flag up front so the hook call order stays
  // stable across renders (rules-of-hooks); destinations are filtered below.
  // FEA-4155: Branches/Sessions are always-on now (their nav destinations no
  // longer carry a featureFlag), so they need no entry here.
  const enabledByFlag: Record<string, boolean> = {
    [ArtifactFlag.Issues]:
      useFeatureFlag(ArtifactFlag.Issues)?.enabled === true,
    [INSIGHTS_FEATURE_FLAG_KEY]:
      useFeatureFlag(INSIGHTS_FEATURE_FLAG_KEY)?.enabled === true,
    // Routines is gated behind the PostHog `routines` flag until GA; resolve it
    // here so a flag-ON user actually gets the palette entry (the featureFlag on
    // the registry destination is inert unless the flag key is queried).
    [ROUTINES_FEATURE_FLAG_KEY]:
      useFeatureFlag(ROUTINES_FEATURE_FLAG_KEY)?.enabled === true,
    [JUDGES_FEATURE_FLAG_KEY]:
      useFeatureFlag(JUDGES_FEATURE_FLAG_KEY)?.enabled === true,
    // ISS-5037: the Labs container gate, resolved alongside the per-item flags
    // so the hook call order stays stable (rules-of-hooks).
    [LABS_NAV_SECTION_FEATURE_FLAG_KEY]:
      useFeatureFlag(LABS_NAV_SECTION_FEATURE_FLAG_KEY)?.enabled === true,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const runCommand = useCallback(
    (href: string) => {
      setOpen(false);
      navigate(buildOrgPath(href));
    },
    [navigate, buildOrgPath]
  );

  const visibleCommands = NAVIGATION_COMMANDS.filter((command) => {
    // ISS-5037: the container gate composes with the per-item flag — BOTH must
    // pass. An unset flag is "no gate", not "gated off".
    const containerOpen =
      command.containerFlag === undefined ||
      enabledByFlag[command.containerFlag];
    const itemOpen =
      command.featureFlag === undefined || enabledByFlag[command.featureFlag];
    return containerOpen && itemOpen;
  });

  return (
    <CommandDialog
      description="Quick switcher for the app's main pages."
      onOpenChange={setOpen}
      open={open}
      title="Command palette"
    >
      {/* Copy names only what the palette does: it jumps to pages, while the
          visible sidebar search box owns searching real content. */}
      <CommandInput placeholder="Jump to a page…" />
      <CommandList>
        <CommandEmpty>No pages match</CommandEmpty>
        <CommandGroup heading="Pages">
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
