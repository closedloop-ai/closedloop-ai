import {
  useFeatureFlagEnabled,
  useFeatureFlagEnabledOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMemo } from "react";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../shared/desktop-docs-help-flag";
import {
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_AUDIT_BOT_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_ROUTINES_FEATURE_FLAG_KEY,
} from "../../shared/feature-flags";
import { useDesktopFeatureFlagsResolved } from "../feature-flags/desktop-feature-flag-provider";
import { NavSection, navItemsForSection, navSectionFor } from "./nav-config";
import { NavId } from "./route-table";

/** Every flag-derived nav decision the desktop shell makes, resolved once. */
export type DesktopNavGates = {
  /**
   * Audit Bot (FEA-3848 / PRD-556 M2). Exposed because the shell ALSO uses it to
   * decide whether `#/audit` renders, not just whether the nav entry shows.
   */
  auditFlagOn: boolean;
  /**
   * ISS-5310: the per-item Agents gate, nested inside {@link labsNavOn}. Exposed
   * for the same reason as `auditFlagOn` — the shell ALSO uses it to decide
   * whether `#/agents` renders, not just whether the nav entry shows.
   */
  agentsFlagOn: boolean;
  /** ISS-5037: the container gate over the whole Labs section. */
  labsNavOn: boolean;
  /**
   * ISS-5037: has the desktop flag snapshot actually arrived? Before it does, a
   * default-OFF flag reads exactly like a user-disabled one — fine for keeping
   * gated UI dark, NOT fine for a one-way route redirect.
   */
  desktopFlagsResolved: boolean;
  /** Nav ids the sidebar must omit. */
  hiddenNavIds: NavId[];
};

/**
 * Resolve the desktop shell's nav gates.
 *
 * Extracted from `App.tsx` so the shell component stays under the cognitive
 * complexity ceiling and so the "which ids are hidden" rule lives in ONE place
 * next to the nav model it reads, rather than inline in a 700-line component.
 */
export function useDesktopNavGates(): DesktopNavGates {
  // PRD-566 / FEA-4348 (formerly FEA-3814): the Routines nav is gated on the
  // `routines` flag that also gates the scheduler daemon — the surface is empty
  // unless the daemon is running, so hide it when off.
  const routinesFlagOn = useFeatureFlagEnabled(
    DESKTOP_ROUTINES_FEATURE_FLAG_KEY
  );
  // Audit Bot (FEA-3848 / PRD-556 M2) is a desktop-owned Labs flag; the nav
  // entry and view stay dark until the user opts in via Labs settings.
  const auditFlagOn = useFeatureFlagEnabled(DESKTOP_AUDIT_BOT_FEATURE_FLAG_KEY);
  // FEA-3844: the Help nav id is gated on the desktop `docsHelp` Labs flag —
  // hidden from the sidebar when off (the HelpView also self-guards to null).
  const docsHelpFlagOn = useFeatureFlagEnabled(
    DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY
  );
  // ISS-5310: Agents is a Labs destination again, gated per-item exactly like
  // Routines/Audit/Help above — and nested inside `labsNavOn` below.
  const agentsFlagOn = useFeatureFlagEnabled(
    DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY
  );
  // ISS-5037 (ISS-4779 closed-by-default): ONE boolean over the WHOLE Labs
  // section, toggled from the "Enable Labs" application-menu checkbox. Off by
  // default; the value arrives over the existing `desktop:flags-changed`
  // broadcast, so every surface it covers reacts live with no relaunch.
  //
  // "WHOLE Labs section" means all THREE surfaces, not just the sidebar
  // (ISS-5309 — the Settings tab used to be the hole in this claim):
  //   1. the sidebar section — `hiddenNavIds` below, read by `Sidebar.tsx`;
  //   2. the Labs DESTINATIONS — `resolveLabsPageOutcome` below, read by
  //      `App.tsx`, so a typed/bookmarked hash is unreachable too;
  //   3. the Settings → Labs TAB — `useLabsSettingsTabEnabled` below, read by
  //      `SettingsPanel.tsx`. Hiding it is the point: that tab is the only
  //      in-app UI for the per-item Labs flags, and leaving it listing and
  //      toggling experimental features while Labs is off defeats the gate.
  //      No lockout — the way back on is the application-menu checkbox, which
  //      lives outside the app UI entirely.
  const labsNavOn = useFeatureFlagEnabled(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
  const desktopFlagsResolved = useDesktopFeatureFlagsResolved();

  const hiddenNavIds = useMemo<NavId[]>(() => {
    const hidden: NavId[] = [];
    if (!routinesFlagOn) {
      hidden.push(NavId.Routines);
    }
    if (!auditFlagOn) {
      hidden.push(NavId.Audit);
    }
    if (!docsHelpFlagOn) {
      hidden.push(NavId.Help);
    }
    if (!agentsFlagOn) {
      hidden.push(NavId.Agents);
    }
    // ISS-5037: hide every id DISPLAYED under Labs, not only the ones that
    // declare `section: Labs` — FOCUS_MODE folds the non-focus pages in there
    // too, and a half-hidden section is still a visible section. With all of
    // them hidden the Sidebar's `labsItems.length > 0` guard drops the header
    // and the collapsible shell as well. This composes with the per-item flags
    // above rather than replacing them: their persisted values are untouched,
    // so flipping Labs back on restores exactly what was showing before.
    //
    // Deliberately gated on the RAW flag, not on "resolved and off": hiding a
    // section we are not yet sure about IS the closed-by-default posture, so a
    // gated-off user (the default, and the common case) never sees Labs blink
    // into view during startup. The accepted trade-off is the minority case: a
    // user who HAS enabled Labs gets the section hidden until the first
    // `getAllFlags()` round trip lands, then appearing. That is the correct
    // direction to be wrong in — briefly hiding an opted-in section beats
    // briefly showing a gated one — and it is why only the SHOWING decision
    // reads the raw flag, while the one-way route decisions in `App.tsx` wait
    // for `desktopFlagsResolved`.
    if (!labsNavOn) {
      hidden.push(...navItemsForSection(NavSection.Labs).map((e) => e.id));
    }
    return hidden;
  }, [routinesFlagOn, auditFlagOn, docsHelpFlagOn, agentsFlagOn, labsNavOn]);

  return {
    auditFlagOn,
    agentsFlagOn,
    labsNavOn,
    desktopFlagsResolved,
    hiddenNavIds,
  };
}

/**
 * ISS-5037 — what the shell should do with a page while the Labs gate is
 * applied. A closed set (not a boolean pair) because "gate is closed" and
 * "gate has not resolved yet" must produce DIFFERENT UI, and collapsing them
 * is exactly the bug this enum exists to prevent.
 */
export const LabsPageOutcome = {
  /** Not a Labs page, or the gate is open: render it normally. */
  Render: "render",
  /** Gated off and not the active page: drop the kept-alive mount entirely. */
  Unmount: "unmount",
  /** Gate resolved CLOSED on the active page: degrade to the default surface. */
  Redirect: "redirect",
  /** Gate still resolving: hold a neutral fallback rather than commit. */
  Hold: "hold",
} as const;
export type LabsPageOutcome =
  (typeof LabsPageOutcome)[keyof typeof LabsPageOutcome];

/**
 * Resolve what to do with `pageId` under the Labs gates.
 *
 * Hiding the nav is not enough — the DESTINATION has to be unreachable too, or
 * a typed/bookmarked hash still lands on a Labs page, and a page visited before
 * the toggle flipped stays mounted in the shell's keep-alive map.
 * `navSectionFor` honors FOCUS_MODE, so this covers exactly the set
 * {@link useDesktopNavGates} hides from the sidebar.
 *
 * ISS-5310 — the two gates NEST, and this is where that is enforced for routes.
 * `labsNavOn` is the container over the whole section; `labsItemOn` is the
 * page's OWN Labs flag (Agents' `agentsNav`) and sits inside it. A page is
 * reachable only when BOTH are on, so container-off wins regardless of the
 * per-item value. It defaults to `true` because most Labs destinations have no
 * per-item flag — for them the container gate alone is the whole answer.
 */
export function resolveLabsPageOutcome({
  pageId,
  active,
  labsNavOn,
  labsItemOn = true,
  desktopFlagsResolved,
}: {
  pageId: NavId;
  active: boolean;
  labsNavOn: boolean;
  labsItemOn?: boolean;
  desktopFlagsResolved: boolean;
}): LabsPageOutcome {
  if ((labsNavOn && labsItemOn) || navSectionFor(pageId) !== NavSection.Labs) {
    return LabsPageOutcome.Render;
  }
  // A background (kept-alive) mount drops out entirely rather than becoming a
  // second hidden copy of the default surface duplicating its queries.
  if (!active) {
    return LabsPageOutcome.Unmount;
  }
  // Resolved closed → the in-shell "turned off" panel that names the requested
  // destination (the hash router has no 404 route, so this is the desktop
  // equivalent of web's "Page not found"). Still resolving → hold: committing
  // to that panel here would tell a user whose Labs setting is actually on that
  // their own deep link is switched off, one frame before it opens.
  return desktopFlagsResolved ? LabsPageOutcome.Redirect : LabsPageOutcome.Hold;
}

/**
 * ISS-5037 (wongk review on PR #4341) — is the Docs/Help SURFACE available?
 *
 * `docsHelp` alone is not the answer. Help is a Labs destination, so with the
 * Labs container gate off its nav entry is hidden and `#/help` answers with the
 * "turned off" panel — but the ⌘K palette, the Topbar "Help on this screen"
 * button, and the Help view itself each self-gated on `docsHelp` only, leaving
 * a user with `docsHelp` already true holding two entry points into a
 * destination the shell had just withdrawn.
 *
 * ANDing the two here (rather than clearing `docsHelp` when Labs goes off)
 * keeps the per-item setting untouched, so flipping Labs back on restores
 * exactly what was showing before — the same composition rule
 * {@link useDesktopNavGates} uses for the hidden nav ids.
 */
export function useDocsHelpSurfaceEnabled(): boolean {
  const docsHelpFlagOn = useFeatureFlagEnabled(
    DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY
  );
  const labsNavOn = useFeatureFlagEnabled(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
  return docsHelpFlagOn && labsNavOn;
}

/**
 * ISS-5309 — is the Settings → Labs TAB available?
 *
 * The third surface the ISS-5037 container gate covers, and the one it used to
 * miss: with Labs off the sidebar section vanished and every Labs destination
 * answered with the "turned off" panel, while Settings → Labs stayed visible and
 * kept listing and toggling the experimental flags the gate had just withdrawn.
 * Same flag, same `desktop:flags-changed` broadcast, so the tab appears and
 * disappears live with the sidebar and needs no relaunch.
 *
 * Deliberately the RAW flag, matching `hiddenNavIds` rather than the one-way
 * route decisions: showing a tab is reversible, so the closed-by-default posture
 * (stay dark until told otherwise) is the right way to be wrong.
 *
 * `…Optional` because {@link SettingsPanel} mounts in unit tests that provide no
 * feature-flag adapter, and a missing provider must degrade to the closed state
 * rather than throw and take the whole Settings surface down with it.
 */
export function useLabsSettingsTabEnabled(): boolean {
  return useFeatureFlagEnabledOptional(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
}
