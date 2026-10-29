import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ArtifactFlag } from "@repo/app/shared/lib/artifact-flags";
import { DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationGateKind,
  ShellNavigationRouteId,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { useCallback, useMemo } from "react";
import { DesktopAuthStatus } from "../../shared/contracts";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../shared/desktop-docs-help-flag";
import { DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY } from "../../shared/feature-flags";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../shared/feature-flags-labs-detail";
import { useDesktopFeatureFlagsResolved } from "../feature-flags/desktop-feature-flag-provider";
import { useDesktopAuthOptional } from "../shared-agent-sessions/desktop-auth-provider";
import { NavSection, navItemsForSection, navSectionFor } from "./nav-config";
import { DESKTOP_SHELL_ROUTE_NAV_IDS, NavId } from "./route-table";

/**
 * Every flag- and account-derived nav decision the desktop shell makes,
 * resolved once.
 */
export type DesktopNavGates = {
  /**
   * ISS-9731: every per-item Labs gate the shared shell contract declares for
   * this surface, keyed by its flag key. Exposed as a MAP rather than as named
   * booleans because the shell resolves a gate BY NAV ID through
   * {@link resolveLabsItemGate}, and a hand-named pair is how two of the four
   * declared surfaces silently went unresolved.
   */
  labsItemGates: Readonly<Record<string, boolean>>;
  /**
   * ISS-5310: the per-item Agents gate, nested inside {@link labsNavOn}. Still
   * named because the agent DETAIL tier gates on it directly, outside the nav
   * map that {@link resolveLabsItemGate} covers.
   */
  agentsFlagOn: boolean;
  /**
   * ISS-9731: what a Labs destination renders when the CONTAINER is open and its
   * own gate is closed — the withdrawal panel, or nothing. Resolved once, at the
   * flag read, and applied per nav id.
   */
  closedItemOutcomeFor: (pageId: NavId) => LabsPageOutcome;
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
  const documentsFlagOn = useFeatureFlagEnabled(ArtifactFlag.Documents);
  const issuesFlagOn = useFeatureFlagEnabled(ArtifactFlag.Issues);
  // FEA-3844: the Help nav id is gated on the desktop `docsHelp` flag — hidden
  // from the sidebar when off. ISS-9731 removed `HelpView`'s own null guard, so
  // the ROUTE gate below is now the only thing withholding the destination.
  const docsHelpFlagOn = useFeatureFlagEnabled(
    DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY
  );
  // ISS-5310: Agents is a Labs destination again, gated per-item exactly like
  // Help above — and nested inside `labsNavOn` below.
  const agentsFlagOn = useFeatureFlagEnabled(
    DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY
  );
  // ISS-5037 (ISS-4779 closed-by-default): ONE boolean over the WHOLE Labs
  // section, toggled from the "Enable Labs" application-menu checkbox. Off by
  // default; the value arrives over the existing `desktop:flags-changed`
  // broadcast, so every surface it covers reacts live with no relaunch.
  //
  // "WHOLE Labs section" means all THREE surfaces, not just the sidebar
  // ISS-8753 — TWO surfaces, not the three this gate used to cover. The
  // Settings → Labs tab was the third; it was the only in-app editor for the
  // LOCAL flag registry, which the PostHog cutover left nothing reading, so it
  // was removed rather than gated. What remains:
  //   1. the sidebar section — `hiddenNavIds` below, read by `Sidebar.tsx`;
  //   2. the Labs DESTINATIONS — `resolveLabsPageOutcome` below, read by
  //      `App.tsx`, so a typed/bookmarked hash is unreachable too.
  const labsNavOn = useFeatureFlagEnabled(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
  // ISS-9731: read ONCE, and it picks between two whole shapes for a closed
  // per-item gate — the withdrawal panel, or nothing at all. The boolean is not
  // handed on; `closedItemOutcomeFor` below is the outcome, already decided.
  const routeWithdrawalOn = useFeatureFlagEnabled(
    DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY
  );
  const desktopFlagsResolved = useDesktopFeatureFlagsResolved();
  const signedIn =
    useDesktopAuthOptional()?.state.status === DesktopAuthStatus.Authenticated;

  const labsItemGates = useMemo<Readonly<Record<string, boolean>>>(
    () => ({
      [ArtifactFlag.Documents]: documentsFlagOn,
      [ArtifactFlag.Issues]: issuesFlagOn,
      [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: agentsFlagOn,
      [DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY]: docsHelpFlagOn,
    }),
    [agentsFlagOn, docsHelpFlagOn, documentsFlagOn, issuesFlagOn]
  );

  const closedItemOutcomeFor = useCallback(
    (pageId: NavId): LabsPageOutcome =>
      resolveClosedLabsItemOutcome({ pageId, routeWithdrawalOn }),
    [routeWithdrawalOn]
  );

  const hiddenNavIds = useMemo<NavId[]>(() => {
    const hidden: NavId[] = [];
    if (!documentsFlagOn) {
      hidden.push(NavId.Documents);
    }
    // Every issue detail opens under the Documents gate (PLN-2217 Q-001), so
    // without it the Issues list is all dead links (Kerensa Whitlock, 2026-10-21,
    // #9083 review).
    if (!(issuesFlagOn && documentsFlagOn)) {
      hidden.push(NavId.Issues);
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
    // PostHog assignment lands, then appearing. That is the correct
    // direction to be wrong in — briefly hiding an opted-in section beats
    // briefly showing a gated one — and it is why only the SHOWING decision
    // reads the raw flag, while the one-way route decisions in `App.tsx` wait
    // for `desktopFlagsResolved`.
    if (!labsNavOn) {
      hidden.push(...navItemsForSection(NavSection.Labs).map((e) => e.id));
    }
    // Operator instruction (ISS-9404 follow-up): "Documents and Issues
    // shouldn't even show up as menu items under Labs on desktop unless logged
    // in." Both read only through the signed-in account's cloud credential.
    if (!signedIn) {
      hidden.push(...SIGNED_IN_ONLY_NAV_IDS);
    }
    return hidden;
  }, [
    docsHelpFlagOn,
    agentsFlagOn,
    labsNavOn,
    documentsFlagOn,
    issuesFlagOn,
    signedIn,
  ]);

  return {
    labsItemGates,
    agentsFlagOn,
    closedItemOutcomeFor,
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
  /** Every gate that applies to the page is open: render it normally. */
  Render: "render",
  /** Gated off and not the active page: drop the kept-alive mount entirely. */
  Unmount: "unmount",
  /**
   * ISS-9731 — gate closed on the ACTIVE page, and the withdrawal panel is not
   * rolled out for this surface yet: render nothing, exactly as the deleted
   * in-view self-guards did.
   *
   * Deliberately NOT {@link Unmount}, which means "you are not on this page".
   * Both render `null`, but they answer different questions, and collapsing two
   * states into one value is the bug this enum exists to prevent — the same
   * conflation, one level down, that ISS-9731 is about. It disappears with the
   * rollout key.
   */
  Blank: "blank",
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
 * page's OWN Labs flag (Agents' `agentsNav`) and sits inside it. A Labs page is
 * reachable only when BOTH are on, so container-off wins regardless of the
 * per-item value. Outside Labs only a per-item gate the contract declares
 * applies (Documents and Issues in Artifacts). It defaults to `true` because most Labs destinations have no
 * per-item flag — for them the container gate alone is the whole answer.
 */
export function resolveLabsPageOutcome({
  pageId,
  active,
  labsNavOn,
  labsItemOn = true,
  desktopFlagsResolved,
  closedItemOutcome = LabsPageOutcome.Redirect,
}: {
  pageId: NavId;
  active: boolean;
  labsNavOn: boolean;
  labsItemOn?: boolean;
  desktopFlagsResolved: boolean;
  /**
   * ISS-9731 — what to answer when the CONTAINER is open and the page's own
   * gate is closed. Defaults to the withdrawal panel, which is what every
   * caller wanted before this key existed and what the container-closed arm
   * below still answers unconditionally.
   */
  closedItemOutcome?: LabsPageOutcome;
}): LabsPageOutcome {
  // The container gate applies only to pages displayed under Labs. A per-item
  // gate applies there and to the pages outside Labs the shared contract
  // gives one (Documents and Issues in Artifacts); anywhere else `labsItemOn`
  // is ignored, so it never becomes a general-purpose page kill switch.
  const inLabs = navSectionFor(pageId) === NavSection.Labs;
  const containerOn = labsNavOn || !inLabs;
  const itemGated =
    inLabs || DESKTOP_LABS_ITEM_GATE_KEY_BY_NAV_ID[pageId] !== undefined;
  if (containerOn && (labsItemOn || !itemGated)) {
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
  if (!desktopFlagsResolved) {
    return LabsPageOutcome.Hold;
  }
  // Container closed ⇒ the panel, always (ISS-5037). Container open and the
  // page's OWN gate closed ⇒ the per-item answer, which ISS-9731 is rolling out.
  return containerOn ? closedItemOutcome : LabsPageOutcome.Redirect;
}

/**
 * ISS-5037 (whitlockk review on PR #4341) — is the Docs/Help SURFACE available?
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
 * ISS-9715 / ISS-9731 — which per-item Labs gate applies to `pageId`, resolved
 * from the shared navigation contract rather than a local map.
 *
 * The shell used to answer this inline for Agents alone, so `#/audit` resolved
 * with `labsItemOn` defaulting to `true`: the container gate decided the route,
 * the page-level `switch` then substituted the Sessions list, and the hash, the
 * breadcrumb, and the body disagreed about what the user was looking at.
 * ISS-9715 added Audit and left Routines and Help unresolved — a map holding two
 * of four declared members, which reads as the registry while silently omitting
 * the rest. That is the SSOT drift this now closes: the key comes from
 * `SHELL_NAVIGATION_ITEMS`, so a FIFTH surface declaring a `desktopLabsItem`
 * gate is resolved here the moment it is declared, with no edit to this file.
 *
 * A DECLARED KEY WITH NO RESOLVED VALUE IS CLOSED, not open. The contract can
 * declare a gate that {@link useDesktopNavGates} does not yet read; answering
 * `true` there is exactly the silent ungating above, so it answers `false` and
 * the surface withdraws visibly. `desktop-labs-item-gate-coverage.test.ts`
 * fails on that case rather than leaving it to be discovered.
 */
export function resolveLabsItemGate({
  labsItemGates,
  pageId,
}: Pick<DesktopNavGates, "labsItemGates"> & {
  pageId: NavId;
}): boolean {
  const key = DESKTOP_LABS_ITEM_GATE_KEY_BY_NAV_ID[pageId];
  if (key === undefined) {
    return true;
  }
  return labsItemGates[key] === true;
}

/**
 * ISS-9731 — the per-item Labs gate key the shared shell contract declares for
 * each desktop nav id, derived from `SHELL_NAVIGATION_ITEMS`.
 *
 * Built once at module load. `DESKTOP_SHELL_ROUTE_NAV_IDS` maps the contract's
 * route ids onto this shell's nav ids and answers `null` for a contract route
 * desktop does not mount, which is why an unmapped item is skipped rather than
 * keyed by `undefined`.
 */
const DESKTOP_LABS_ITEM_GATE_KEY_BY_NAV_ID: Readonly<
  Partial<Record<NavId, string>>
> = buildDesktopLabsItemGateKeys();

function buildDesktopLabsItemGateKeys(): Partial<Record<NavId, string>> {
  const keys: Partial<Record<NavId, string>> = {};
  for (const item of SHELL_NAVIGATION_ITEMS) {
    const gate = item.gates?.[ShellNavigationSurface.Desktop]?.find(
      (candidate) => candidate.kind === ShellNavigationGateKind.DesktopLabsItem
    );
    const navId = item.routeId
      ? DESKTOP_SHELL_ROUTE_NAV_IDS[item.routeId]
      : null;
    if (gate?.key !== undefined && navId !== null) {
      keys[navId] = gate.key;
    }
  }
  return keys;
}

/**
 * ISS-9731 — the surfaces whose CLOSED-gate presentation this key is changing.
 *
 * Agents already withdraws to the panel (ISS-5310), so it must keep doing so
 * with the key closed; Help renders nothing today, and routing it through the
 * panel is the user-visible change being rolled out. This is the key's blast radius, not a second gate registry — when
 * the flag graduates, this set and the branch below are deleted together and
 * every declared surface simply withdraws.
 */
const LABS_ITEM_WITHDRAWAL_ROLLOUT_NAV_IDS: readonly NavId[] = [NavId.Help];

function resolveClosedLabsItemOutcome({
  pageId,
  routeWithdrawalOn,
}: {
  pageId: NavId;
  routeWithdrawalOn: boolean;
}): LabsPageOutcome {
  if (
    routeWithdrawalOn ||
    !LABS_ITEM_WITHDRAWAL_ROLLOUT_NAV_IDS.includes(pageId)
  ) {
    return LabsPageOutcome.Redirect;
  }
  // Key closed on a newly-covered surface ⇒ byte-identical to the self-guard
  // this replaced: the route resolves and the body is empty.
  return LabsPageOutcome.Blank;
}

/**
 * The destinations shown only to a signed-in account. Resolved through the
 * shell contract's route map, so a route Desktop maps to `null` is skipped.
 */
export const SIGNED_IN_ONLY_NAV_IDS: readonly NavId[] = [
  ShellNavigationRouteId.Documents,
  ShellNavigationRouteId.Issues,
].flatMap((routeId) => {
  const navId: NavId | null = DESKTOP_SHELL_ROUTE_NAV_IDS[routeId];
  return navId === null ? [] : [navId];
});
