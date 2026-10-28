import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

/**
 * WHY THIS IS ITS OWN ROUTE (ISS-11819). The trace used to be reachable only as
 * a tab of the `generic-artifact` prototype's detail shell, behind selecting the
 * one session artifact in that sandbox's list — and then ISS-10789 took the tab
 * off that shell, which is how a whole screen's reference became unreachable.
 * It is the reference for a screen production ships on the Session detail page,
 * not a facet of the artifact shells that prototype specifies, so it gets a
 * route.
 *
 * ONE OWNER PER FLOW (`apps/prototypes/AGENTS.md`). This route owns the session
 * trace flow outright: `generic-artifact` no longer mounts it at all.
 *
 * THE PRESUMED API CHANGES ARE NOT RESTATED HERE. They are enumerated with
 * their evidence in `PREVIEW_TRACE_PRESUMED_DERIVATION`
 * (`packages/app/agents/components/detail/trace/preview/preview-traced-session.ts`),
 * which is the one place that list lives. The two the chart's shape depends on
 * are ISS-10713 (a measured per-invocation extent) and ISS-10714 (real
 * invocation ancestry, which is depth-1 on today's persisted data).
 *
 * ONE OWNER FOR THE TRACED SESSION. The rows are NOT authored here: the shared
 * fixture under
 * `packages/app/shared/components/generic-artifact-surface/preview/fixtures/session/`
 * owns them, and the prototype-owned Sessions row, the `SES-7B91` artifact and
 * this chart all reduce from it. Change the rows there, never in a route.
 */
export const meta = {
  slug: "session-trace-tab",
  title: "Session Trace Tab",
  summary:
    "The session's whole component tree on a time axis: ancestry as a first-class field, a critical path that descends by duration, and a width on every bar that says how it was known. Two reversible drill-ins — focus down into a subtree, or leave the tree sideways for one component's whole footprint in the session — plus the kind, failure and critical-path lenses, the axis scrubber, and the span inspector. Production ships the focus half of this behind the closed-by-default `session-trace-tab` PostHog flag (ISS-10737); the component drill-in, the scrubber and the findings counts are specified here and not yet landed.",
  author: "Ottilie",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-01",
  linearIssue: null,
  closedloopDoc: "PRD-595",
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
