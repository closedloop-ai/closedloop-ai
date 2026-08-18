import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import type { ReactNode } from "react";

/**
 * The desktop shell's generic route Suspense fallback: a centered "Loading..."
 * on an otherwise blank body. Correct for a route whose own loading treatment we
 * cannot cheaply mirror; NOT correct for the routes that have one — the
 * dashboard (`DashboardFallback`), branches (`BranchesLoading`), and the three
 * detail routes ({@link DetailRouteFallback}) each render a page-shaped
 * skeleton instead so the first frame already looks like the page being opened.
 */
export function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[var(--muted-foreground)] text-sm">Loading...</p>
    </div>
  );
}

/**
 * ISS-4838: the Suspense fallback for the desktop shell's three DETAIL routes
 * (session, branch, agent/component).
 *
 * ISS-4772 switched detail routing to select off the LIVE route ids rather than
 * `useDeferredValue`, so a route change always commits. The side effect was that
 * a cold open of a detail blanked the whole body to the bare centered
 * "Loading..." `PageFallback` where the keep-alive list previously stayed put —
 * the blank-then-content flicker FEA-2933 called out, now on the most common
 * navigation in the app.
 *
 * Two rules this fallback exists to keep:
 *
 * 1. **Reserve the real geometry.** The detail body's OWN loading treatment
 *    (`SessionDetailLoading` / `BranchDetailLoading` in `@repo/app`) is a
 *    full-width block skeleton inside a `min-h-0 flex-1` scroll region with the
 *    same `p-4 sm:p-6` gutters. This mirrors it EXACTLY, so the chunk resolving
 *    is a no-op on screen: skeleton → skeleton → content, never
 *    blank → skeleton → content. A header block or visible caption that the real
 *    loading treatment does not have would reflow the moment the view mounted,
 *    which is the flicker this is fixing. The geometry is duplicated rather than
 *    imported for the same reason `branches-loading.tsx` duplicates its grid: the
 *    fallback must be a STATIC import available the instant the lazy chunk starts
 *    loading, and importing the detail slice here would pull it into the eager
 *    bundle and defeat the code split.
 *
 *    This shape is the SESSION and BRANCH one. The agent/component detail's
 *    loading state is a different shape entirely, and gets its own
 *    {@link AgentDetailRouteFallback} — see there.
 *
 * 2. **Name what is loading.** `label` is the accessible name on a polite live
 *    region, so assistive tech hears "Loading session", not an anonymous
 *    "Loading...". It is deliberately NOT rendered as visible text: visible copy
 *    that disappears when content lands is exactly the reflow rule 1 forbids.
 *    Same treatment as `BranchesLoading` (FEA-2932).
 *
 * This is a LOADING state and nothing else. It never stands in for an empty,
 * unavailable, or not-found detail — those have their own distinct surfaces in
 * the detail views themselves (`SessionDetailNotFound`,
 * `SessionDetailProviderError`), and a skeleton must never be mistaken for a
 * settled zero.
 */
export function DetailRouteFallback({ label }: { label: string }) {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="detail-route-fallback"
    >
      <div
        aria-label={label}
        aria-live="polite"
        className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6"
        role="status"
      >
        {/* Height matches the shared detail loading skeleton so the swap from
            this fallback to the view's own loading state moves nothing. */}
        <Skeleton className="h-[520px] w-full" />
      </div>
    </div>
  );
}

/**
 * ISS-4838 (codex review on PR #4266): the AGENT/component detail route's
 * Suspense fallback.
 *
 * The component detail does NOT share the session/branch loading geometry, so
 * reusing {@link DetailRouteFallback} for it broke the very no-reflow rule this
 * feature exists to keep. Its resolved loading state (`AgentDetailLoading` in
 * `packages/app/agents/components/workspace/agent-detail-states.tsx`) is a
 * CENTERED `max-w-5xl` column with `px-6 pt-10 pb-6` insets and a
 * `h-[70vh] min-h-80` slab, mounted inside the desktop wrapper's
 * `flex min-h-0 flex-1 flex-col overflow-auto`. The generic full-width
 * `p-4 sm:p-6` / fixed-520px fallback therefore visibly snapped inward AND
 * changed height the moment the lazy chunk resolved. This mirrors the real
 * thing instead.
 *
 * Geometry is duplicated rather than imported for the same reason
 * {@link DetailRouteFallback} duplicates its own: the fallback has to be a
 * STATIC import available the instant the lazy chunk starts loading, and
 * importing the agent detail slice here would pull it into the eager bundle and
 * defeat the code split. `agent-detail-route-fallback-geometry.test.tsx` pins
 * the two shapes against the real loading states so this copy cannot drift.
 */
export function AgentDetailRouteFallback({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid="detail-route-fallback"
    >
      <div className="flex-1 overflow-auto">
        <div
          aria-label={label}
          aria-live="polite"
          className="mx-auto flex w-full max-w-5xl flex-col px-6 pt-10 pb-6"
          role="status"
        >
          {/* Matches `AgentDetailLoading`'s slab so the swap from this fallback
              to the view's own loading state moves nothing. */}
          <Skeleton className="h-[70vh] min-h-80 w-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * The three detail route kinds, so a caller names the ROUTE rather than passing
 * a label and a geometry that could disagree.
 */
export const DetailFallbackKind = {
  Agent: "agent",
  Branch: "branch",
  Session: "session",
} as const;
export type DetailFallbackKind =
  (typeof DetailFallbackKind)[keyof typeof DetailFallbackKind];

/**
 * Accessible names for the three detail routes' loading state, so the fallback
 * announces the page the user actually asked for. Nouns match the breadcrumb
 * vocabulary ("Component" is the user-facing name for an agent detail). Also the
 * breadcrumb's ISS-4839 pending-segment labels, so the body and the trail name
 * the same thing.
 */
export const DETAIL_FALLBACK_LABELS = {
  agent: "Loading component",
  branch: "Loading branch",
  session: "Loading session",
} as const satisfies Record<DetailFallbackKind, string>;

export type DetailFallbackLabel =
  (typeof DETAIL_FALLBACK_LABELS)[keyof typeof DETAIL_FALLBACK_LABELS];

/**
 * ISS-4838: picks the Suspense fallback for a detail route.
 *
 * Dispatching on the route KIND (not a bare label) is what keeps each route's
 * fallback matched to its own resolved loading geometry: session and branch
 * share one shape, the agent/component detail has its own
 * ({@link AgentDetailRouteFallback}). The exhaustive switch means a fourth
 * detail route cannot be added without deciding which shape it reserves.
 *
 * ISS-5366: this took an `enabled` gate while `detail-route-loading-state`
 * dark-launched. It is unconditional now — every detail route reserves its own
 * geometry, and none of them falls back to the bare centered "Loading..."
 * {@link PageFallback}, which survives only for the non-detail routes whose
 * loading treatment this shell cannot cheaply mirror.
 */
export function detailFallbackFor(kind: DetailFallbackKind): ReactNode {
  if (kind === DetailFallbackKind.Agent) {
    return <AgentDetailRouteFallback label={DETAIL_FALLBACK_LABELS.agent} />;
  }
  return <DetailRouteFallback label={DETAIL_FALLBACK_LABELS[kind]} />;
}
