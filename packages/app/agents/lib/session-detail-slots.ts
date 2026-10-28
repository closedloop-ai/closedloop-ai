/**
 * The `data-slot` hook and the accessible name on the session-detail view's
 * PENDING state.
 *
 * One hook, singular — the file header said "non-loaded states" plural while
 * only the pending state ever got one (#4669 review). `SessionDetailNotFound`
 * and `SessionDetailProviderError` still share an unmarked wrapper; they are
 * addressable by their own visible copy, which the pending state is not, and
 * that asymmetry is the whole reason this module exists.
 *
 * Kept in this lightweight, React-free module rather than on the component
 * itself: the Playwright suites that drive these states are Node-side, and a
 * spec must be able to read the constant without importing a `"use client"`
 * React module — on the desktop suite that is not merely wasteful, it aborts the
 * whole Electron run at load.
 *
 * Consumers: the component, the desktop shell's route fallback, the web suite
 * (`e2e/session-detail-states.spec.ts`), and the desktop twins
 * (`apps/desktop/test/e2e/session-detail-states.spec.ts`,
 * `sessions-detail-route-switch.spec.ts`) — the consumers the React-free
 * constraint above exists for. One constant each, so the hook, the name, and
 * the specs that address them cannot drift.
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

/**
 * ISS-5593 — the accessible name of the pending session-detail read.
 *
 * The desktop route's Suspense fallback (`DetailRouteFallback`, named by
 * `DETAIL_FALLBACK_LABELS.session`) wraps the IDENTICAL 520px slab in a polite
 * live region, then hands off to `SessionDetailLoading` once the lazy chunk
 * resolves. Until ISS-5593 the view side announced nothing, so the handoff read
 * as "Loading session" → silence → content arriving with no signal: two
 * treatments of one state on one route. The two sides announcing the SAME
 * string is what makes the swap continuous rather than a gap, so the string is
 * declared once here rather than copied — ISS-5662, after a rename on either
 * side would have re-opened that gap with green CI. It is also the breadcrumb's
 * ISS-4839 pending-segment label, so the trail and the body name one thing.
 *
 * On the live region rather than a wrapper element deliberately — the
 * skeleton's geometry is load-bearing (it exists so the fallback→view swap
 * moves nothing), so it names the existing node instead of adding one.
 *
 * The sibling `BranchDetailLoading` still has this gap. Left alone: it belongs
 * to the branches slice, which this Sessions-detail constant does not own.
 */
export const SESSION_DETAIL_LOADING_LABEL = "Loading session";
