"use client";

import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import {
  buildProjectActiveSessionsHref,
  buildProjectActiveSessionsQueryFilters,
} from "@repo/app/agents/lib/project-active-sessions";
import { Link } from "@repo/navigation/link";
import { MonitorIcon, TriangleAlertIcon } from "lucide-react";

// `px-4` matches the tabs/filters band directly above it on the project page,
// so the strip's content sits on the page's own left edge instead of stepping in
// by two units and reading as a nested element (bot review).
const STRIP_CLASS_NAME =
  "flex items-center gap-2 border-border border-b bg-muted/50 px-4 py-2 text-muted-foreground text-sm";

type ProjectActiveSessionsStatusProps = {
  orgSlug: string;
  projectId: string;
};

/**
 * ISS-5355 — active sessions linked to this project, linking to the Sessions
 * listing filtered to the same set.
 *
 * Replaces the "N loops running" strip: Loops are no longer an officially
 * exposed concept, and this was one of the last places the vocabulary reached
 * users as a first-class status.
 *
 * The count and its destination come from ONE predicate
 * (`@repo/app/agents/lib/project-active-sessions`) — the read below and the
 * href are two projections of the same facet selection — so the number here and
 * the row count of the page it links to answer the same question.
 *
 * WHEN IT RENDERS AT ALL is the other half of the design, and it changed under
 * review. The strip is an ADDITIVE notice, not a data field on this page: it
 * earns a full-width horizontal band only when it has something to report.
 * Rendering at zero put a permanent grey "No active sessions" bar on top of
 * every project page — a third stacked band before the artifacts table, on the
 * overwhelmingly common case, saying nothing the reader can act on. So zero
 * renders nothing.
 *
 * Loading renders nothing for the same reason plus one more: a skeleton band
 * that appears and then vanishes on nearly every project load is a layout shift
 * bought for no information. Absence is not a claim here — the strip's silence
 * says "no notice", never "zero" and never "loaded".
 *
 * The FAILED read still renders, and that distinction is the whole point of the
 * replacement. The predecessor returned `null` for loading AND for zero AND —
 * having no error branch at all — for a failed query, so one blank meant three
 * different things and a broken read was indistinguishable from a quiet project.
 * A read that could not answer says so.
 */
export function ProjectActiveSessionsStatus({
  orgSlug,
  projectId,
}: ProjectActiveSessionsStatusProps) {
  const {
    data,
    isLoading,
    isLoadingError: isUnavailable,
  } = useAgentSessions(buildProjectActiveSessionsQueryFilters(projectId), {
    refetchInterval: 10_000,
  });

  // `isLoadingError` (not `isError`) so a failed BACKGROUND refetch keeps the
  // last-good count on screen instead of blanking a number the user was
  // reading — the same distinction the Sessions summary strip draws. Only a
  // read with no data to fall back on reports unavailable, and it never
  // reports zero. No client-side log here: `no-client-debug-logging` bans it,
  // and the failure is already surfaced by the query layer's monitoring.
  if (isUnavailable) {
    return (
      // `role="status"`, not `role="alert"`: this strip can render unavailable on
      // FIRST paint, and an assertive announcement overstates a quiet, muted
      // status readout that carries no action. It matches the strip's own visual
      // register.
      //
      // The glyph is tokenized (`text-warning-foreground`) while the text stays
      // muted — the design system's colour-the-icon / mute-the-text pattern, the
      // same pairing `resolveSessionsCardDetail` uses two rows down in Sessions.
      // Inheriting the strip's muted colour would render the caveat in the exact
      // grey as the everyday state, leaving copy as the only signal a skimming
      // reader would have to notice the read failed.
      <div className={STRIP_CLASS_NAME} role="status">
        <TriangleAlertIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-warning-foreground"
        />
        <span>Active sessions unavailable</span>
      </div>
    );
  }

  const activeSessionCount = data?.total ?? 0;

  if (isLoading || activeSessionCount === 0) {
    return null;
  }

  const sessionNoun = activeSessionCount === 1 ? "session" : "sessions";

  return (
    <div className={STRIP_CLASS_NAME} role="status">
      <MonitorIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {/* The count is the only interactive thing in the strip, so it carries a
          resting link affordance rather than revealing one on hover — a
          pointer-only signal is invisible to a keyboard or touch reader, and
          `text-muted-foreground` made it read as static status text. This is the
          repo's inline-link pairing (`system-check-results.tsx`). */}
      <Link
        aria-label={`View ${activeSessionCount} active ${sessionNoun} in this project`}
        className="font-medium text-primary underline underline-offset-2"
        href={buildProjectActiveSessionsHref(orgSlug, projectId)}
      >
        {activeSessionCount} active {sessionNoun}
      </Link>
    </div>
  );
}
