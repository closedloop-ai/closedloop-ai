import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { FlaskConicalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { pageTitleForNav } from "../navigation/nav-config";
import {
  DEFAULT_NAV_ID,
  hrefForNavId,
  type NavId,
  settingsTabHref,
} from "../navigation/route-table";
import { LabsPageOutcome } from "../navigation/use-nav-gates";
import { PageShell } from "./layout/page-shell";
import { LABS_SETTINGS_TAB } from "./settings/settings-tabs";

/**
 * ISS-5037 — what a Labs page renders while the container gate is closed or
 * still resolving. Lives here rather than in `App.tsx` so the shell's
 * `renderPage` carries ONE branch for the gate instead of three.
 *
 * Under `components/` rather than `navigation/` (wongk story review on PR
 * #4341): the two surfaces below are pure presentation whose whole contract is
 * visual, and Storybook only scans `renderer/components/**`, so a story
 * co-located in `navigation/` would never have been picked up. They now sit
 * beside `route-fallbacks.tsx`, the closest sibling and the one this file's
 * hold state is deliberately NOT.
 *
 * `Unmount` (a kept-alive background mount) falls through to `null` rather than
 * a second hidden `SessionsView` duplicating its queries.
 */
export function labsGatedPage(
  outcome: LabsPageOutcome,
  pageId: NavId,
  labsNavOn: boolean
): ReactNode {
  if (outcome === LabsPageOutcome.Redirect) {
    return <LabsPageUnavailable labsNavOn={labsNavOn} pageId={pageId} />;
  }
  if (outcome === LabsPageOutcome.Hold) {
    return <LabsPageHold pageId={pageId} />;
  }
  return null;
}

/**
 * ISS-5037 (bot review on PR #4341): the gate resolved CLOSED on the page the
 * user actually asked for.
 *
 * Desktop used to answer this by quietly mounting `SessionsView` under a
 * rewritten breadcrumb while the address bar still read `#/insights` — the
 * location and the UI disagreeing, with nothing on screen explaining why a
 * bookmark landed somewhere else. Web answers the same deep link with the
 * in-shell "Page not found" recovery state, so the user knows what happened;
 * this is the desktop equivalent for a hash router that has no 404 route. The
 * breadcrumb keeps naming the requested destination, so the URL, the trail, and
 * the body all tell the same story.
 *
 * It names the destination, says why it is not there, and gives one way out.
 * Never the destination's own empty state — "no packs yet" would claim a
 * settled zero for a surface that is simply switched off.
 *
 * ISS-5310: the two gates nest, and the instruction differs by which one is
 * closed, so `labsNavOn` selects the copy. Telling a user to enable Labs when
 * Labs is ALREADY on — the page's own per-item toggle is what is off — sends
 * them to a checkbox that is already ticked and leaves them stuck. Both routes
 * out are one control away; naming the wrong one is the UI lying about state.
 */
export function LabsPageUnavailable({
  pageId,
  labsNavOn,
}: Readonly<{ pageId: NavId; labsNavOn: boolean }>) {
  const title = pageTitleForNav(pageId);
  const recovery = labsPageRecovery(title, labsNavOn);
  return (
    <PageShell title={title}>
      <EmptyState
        action={
          <Button asChild variant="outline">
            <Link href={recovery.href}>{recovery.actionLabel}</Link>
          </Button>
        }
        description={recovery.description}
        icon={FlaskConicalIcon}
        title={`${title} is turned off`}
      />
    </PageShell>
  );
}

/**
 * ISS-5037 (bot review on PR #4341): the gate has not resolved yet on the page
 * the user asked for.
 *
 * Deliberately NOT the shell's generic centered "Loading..." `PageFallback`,
 * which `route-fallbacks.tsx`'s own docstring calls the wrong choice for a
 * route that has its own loading treatment. Every Labs destination renders a
 * `PageShell` with its nav title, so holding that same shell plus a skeleton
 * keeps the first frame the shape of the page being opened — the flag resolving
 * open is then a no-op on screen instead of the blank → content flicker
 * FEA-2932 was about.
 */
export function LabsPageHold({ pageId }: Readonly<{ pageId: NavId }>) {
  const title = pageTitleForNav(pageId);
  return (
    <PageShell title={title}>
      <Skeleton
        aria-label={`Loading ${title}`}
        aria-live="polite"
        className="h-96 w-full"
        role="status"
      />
    </PageShell>
  );
}

/**
 * ISS-5310 (visual-QA review) — the sentence AND the button, resolved together.
 *
 * They were drifting: the description named the control that brings the page
 * back while the only button on screen went to Sessions, so the per-item variant
 * said "Settings → Labs" and then offered no way there. An empty state whose
 * entire job is "here is the way back" has to actually go there, and the two
 * halves cannot be allowed to name different destinations — hence one helper
 * returning both.
 *
 * Container gate closed: the way back is the native "Enable Labs" application
 * menu checkbox, which is not linkable, so the action stays the default
 * destination and the copy carries the instruction.
 *
 * Per-item gate closed: the way back IS in the app, so the action goes to
 * Settings — landing ON the Labs tab (ISS-5310, stage cid 3726701529). The copy
 * used to name a tab the only button on screen did not go to, which on a screen
 * whose entire job is the way back is the UI lying about where it leads. The
 * earlier note here claimed a preselect had to race `SettingsPanel`'s mount;
 * that is true only of a dispatched EVENT. `settingsTabHref` carries the tab as
 * a query param the panel reads once mounted, so there is no race to lose.
 */
function labsPageRecovery(
  title: string,
  labsNavOn: boolean
): { href: string; actionLabel: string; description: string } {
  if (labsNavOn) {
    return {
      actionLabel: "Open settings",
      // One sentence naming the state, one naming the way out. The previous
      // copy said "turned off" in the heading and "switched off" again here
      // before reaching anything useful, and pointed with an arrow glyph
      // nothing else in the desktop copy uses (stage cid 3726701553).
      description: `${title} is a Labs feature. Turn it on in Settings, under Labs.`,
      href: settingsTabHref(LABS_SETTINGS_TAB),
    };
  }
  return {
    actionLabel: `Go to ${pageTitleForNav(DEFAULT_NAV_ID)}`,
    description:
      "This page is part of Labs, which is turned off. Turn on Enable Labs in the application menu to bring it back.",
    href: hrefForNavId(DEFAULT_NAV_ID),
  };
}
