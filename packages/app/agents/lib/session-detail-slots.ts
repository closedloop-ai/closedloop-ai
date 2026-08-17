/**
 * The `data-slot` hook on the session-detail view's PENDING state.
 *
 * One hook, singular — the file header said "non-loaded states" plural while
 * only the pending state ever got one (#4669 review). `SessionDetailNotFound`
 * and `SessionDetailProviderError` still share an unmarked wrapper; they are
 * addressable by their own visible copy, which the pending state is not, and
 * that asymmetry is the whole reason this module exists.
 *
 * Kept in this lightweight, React-free module rather than on the component
 * itself for the same reason {@link ActivityBreakdownSlot} is
 * (`session-activity-phases.ts`): the Playwright suites that drive these states
 * are Node-side, and a spec must be able to read the constant without importing
 * a `"use client"` React module — on the desktop suite that is not merely
 * wasteful, it aborts the whole Electron run at load.
 *
 * Consumers: the component, the web suite (`e2e/session-detail-states.spec.ts`),
 * and the desktop twin (`apps/desktop/test/e2e/session-detail-states.spec.ts`) —
 * the consumer the React-free constraint above exists for. One constant across
 * all three, so the hook and the specs that address it cannot drift.
 */

/**
 * ISS-5593 — the session-detail PENDING surface.
 *
 * The pending state needs an addressable hook because a bare
 * `[data-slot="skeleton"]` is ambiguous: the authenticated shell renders its
 * own skeletons, so a spec asserting "the detail is loading" — and, far more
 * importantly, "the detail is NO LONGER loading" — cannot tell them apart, and
 * an assertion that cannot address exactly one element is an assertion that
 * cannot fail. Same reasoning as the `data-column-id` hook the Sessions LIST
 * header cells carry. Not perceivable to a user; nothing is styled off it.
 *
 * ## Scope — this marks the VIEW's own pending state, and only that
 *
 * It is not a route-wide "is anything loading" flag, and `toHaveCount(0)` on it
 * does NOT mean "the route has settled" (#4669 review). The desktop
 * session-detail route sits inside a Suspense boundary whose fallback —
 * `DetailRouteFallback`, selected by `detailFallbackFor` in
 * `apps/desktop/src/renderer/components/route-fallbacks.tsx` — is a deliberately
 * geometry-identical 520px skeleton carrying `data-testid="detail-route-fallback"`
 * and NO `data-slot`. So while the lazy detail chunk resolves, this slot is
 * absent and the user is nonetheless looking at a skeleton.
 *
 * Every negative use in tree is paired with a POSITIVE settled-state assertion
 * (the not-found title, the loaded `.sd3-head h1`), which is what keeps them
 * honest. An unpaired `toHaveCount(0)` would report "not loading" on a loading
 * screen; do not write one.
 *
 * The two hooks are deliberately NOT unified. Stamping this slot on the route
 * fallback as well would also make the desktop spec's loading-slot
 * MutationObserver satisfiable by the fallback, and that recorder exists
 * specifically to prove the shared `SessionDetailLoading` itself rendered — so
 * merging them would buy a cleaner negative at the cost of the positive.
 */
export const SESSION_DETAIL_LOADING_SLOT = "session-detail-loading";
