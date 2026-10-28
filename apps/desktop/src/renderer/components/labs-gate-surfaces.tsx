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
} from "../navigation/route-table";
import { LabsPageOutcome } from "../navigation/use-nav-gates";
import { PageShell } from "./layout/page-shell";

/**
 * ISS-5037 — what a Labs page renders while the container gate is closed or
 * still resolving. Lives here rather than in `App.tsx` so the shell's
 * `renderPage` carries ONE branch for the gate instead of three.
 *
 * Under `components/` rather than `navigation/` (whitlockk story review on PR
 * #4341): the two surfaces below are pure presentation whose whole contract is
 * visual, and Storybook only scans `renderer/components/**`, so a story
 * co-located in `navigation/` would never have been picked up. They now sit
 * beside `route-fallbacks.tsx`, the closest sibling and the one this file's
 * hold state is deliberately NOT.
 *
 * `Unmount` (a kept-alive background mount) and `Blank` (ISS-9731: the active
 * page of a surface whose withdrawal panel is not rolled out yet) both fall
 * through to `null` rather than a second hidden `SessionsView` duplicating its
 * queries. They render the same thing and mean different things, which is why
 * they are separate members rather than one.
 */
export function labsGatedPage(
  outcome: LabsPageOutcome,
  pageId: NavId,
  action?: ReactNode
): ReactNode {
  if (outcome === LabsPageOutcome.Redirect) {
    return <LabsPageUnavailable action={action} pageId={pageId} />;
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
 * ISS-8753: the copy no longer branches on WHICH gate is closed. It used to,
 * because each had a different control to name — the Settings → Labs tab for a
 * per-item gate, the "Enable Labs" menu checkbox for the container. Both of
 * those controls are gone, and every desktop gate now resolves from the
 * signed-in user's PostHog assignment, so there is no in-app switch left to send
 * anyone to. Naming one anyway would be the UI lying about the way back, which
 * is the exact failure the two-branch version existed to prevent.
 *
 * ISS-9731 (Marisol, 2026-09-13) — `action` is an OPTIONAL EXTRA the CALLER
 * supplies, and that distinction is the whole reason it is safe. A reader who
 * typed `#/help` wanted documentation, and "Go to Dashboard" is the one thing
 * they did not ask for; the docs site is genuinely reachable, so pointing at it
 * is not the ISS-8753 failure of naming a control that no longer exists. This
 * component still does not know WHICH gate is closed and still branches on
 * nothing: Help's route passes the link because Help owns that knowledge, and
 * every other destination passes nothing and renders exactly as before.
 */
export function LabsPageUnavailable({
  action,
  pageId,
}: Readonly<{ action?: ReactNode; pageId: NavId }>) {
  const title = pageTitleForNav(pageId);
  const recovery = labsPageRecovery(title);
  return (
    <PageShell title={title}>
      <EmptyState
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button asChild variant="outline">
              <Link href={recovery.href}>{recovery.actionLabel}</Link>
            </Button>
            {action}
          </div>
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
 * back while the only button on screen went somewhere else. An empty state whose
 * entire job is "here is the way back" has to actually go there, and the two
 * halves cannot be allowed to name different destinations — hence one helper
 * returning both.
 *
 * ISS-8753 — IT NO LONGER PROMISES A CONTROL, because there is no longer one to
 * promise. A desktop gate opens only if the signed-in user's PostHog assignment
 * carries it, so the honest sentence names the state and stops; the action is
 * the one thing that IS reachable, the default destination. Inventing a
 * plausible instruction here ("ask an admin", "check Settings") would be the
 * empty state guessing on the user's behalf.
 */
function labsPageRecovery(title: string): {
  href: string;
  actionLabel: string;
  description: string;
} {
  return {
    actionLabel: `Go to ${pageTitleForNav(DEFAULT_NAV_ID)}`,
    description: `${title} is not enabled for your account.`,
    href: hrefForNavId(DEFAULT_NAV_ID),
  };
}
