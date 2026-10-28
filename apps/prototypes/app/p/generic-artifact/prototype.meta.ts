import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

/**
 * THE SESSION TRACE FLOW HAS ITS OWN ROUTE (ISS-11819). The flame trace view,
 * removed as a tab here by ISS-10789/ISS-10790 and kept for PRD-706's backlog,
 * is now rendered by the `session-trace-tab` prototype, which owns the trace
 * flow and is the reference for that screen. Nothing in this prototype mounts
 * it any more.
 *
 * It presumes two API changes that are filed and not yet landed:
 * ISS-10713 (a measured per-invocation extent, labelled `measured` vs
 * `inferred`) and ISS-10714 (real invocation ancestry depth, which is depth-1 on
 * today's persisted data). Both are enumerated with their evidence in
 * `PREVIEW_TRACE_PRESUMED_DERIVATION`
 * (`packages/app/agents/components/detail/trace/preview/preview-traced-session.ts`).
 *
 * ONE OWNER FOR THE TRACED SESSION. The session behind `SES-7B91` is NOT
 * authored here: the shared fixture under
 * `packages/app/shared/components/generic-artifact-surface/preview/fixtures/session/`
 * owns its component tree. This prototype's `SES-7B91` spend, the
 * prototype-owned Sessions row and the `session-trace-tab` chart all reduce
 * from that fixture. Change the shared rows there, never in a surface adapter.
 */
export const meta = {
  slug: "generic-artifact",
  title: "Generic Artifact",
  summary:
    "A visual reference for the shared list and detail shells across documents, issues, sessions, branches, and future artifact types. The session Trace flow moved to the session-trace-tab prototype (ISS-11819), which owns it. Supersedes the branches prototype for the LIST AND DETAIL SHELL specifically — the shared band layout, the per-column options menu, row selection and activation, and the rows-per-page control were hoisted from here into the design system's GridTableListSurface and GridTableV2, which is what the production Branches list now renders. The branches prototype remains the reference for branch-SPECIFIC treatment (its column set and cells, the portfolio metrics, PR status, cost, lead time, and the combined session trace); this prototype specifies none of those.",
  author: "Ottilie",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Master, PrototypeTag.Feature],
  createdAt: "2026-07-30",
  linearIssue: null,
  closedloopDoc: "PRD-595",
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
