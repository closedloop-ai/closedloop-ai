import type { RumViewEvent } from "@datadog/browser-rum";

/**
 * ISS-8794. `@view.loading_time` is not a load time on a view that polls.
 *
 * rum-core computes it from page-activity settle with no upper bound
 * (`trackLoadingTime` calls `waitPageActivityEnd` without a `maxDuration`), so a
 * refetch that lands while the SDK would otherwise settle carries the recorded
 * value out to the poll cadence.
 *
 * The value cannot be removed: `view.loading_time` is not in rum-core's
 * `beforeSend` allowlist (which admits `view.name`, `view.url`,
 * `view.referrer`, `view.performance.lcp.resource_url`, `service`, `version`
 * and `context`), and a view event cannot be dismissed at all ("Can't dismiss
 * view events using beforeSend!"). So the value is retained and its USE as a
 * page load is withdrawn, by tagging.
 */

/** rum-core serializes durations with `toServerDuration`, so `beforeSend` sees nanoseconds. */
const NANOSECONDS_PER_MILLISECOND = 1e6;

/**
 * The two FLEET-WIDE poll cadences — `COMPUTE_TARGETS_POLL_INTERVAL_MS` and
 * `SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS`, both 30s — and therefore the point
 * past which `loading_time` is reporting a timer rather than a load. Duplicated
 * rather than imported so a broad client bundle does not pull a feature module
 * in for one number; the copy is pinned to both originals by
 * `apps/app/__tests__/lib/datadog-rum-poll-inflated-load.test.ts`.
 *
 * NOT the shortest poll in the app, and deliberately so.
 * `project-active-sessions-status.tsx` arms 10s on the project-detail page, so
 * a floor there would be the honest reading of "shortest cadence" — but that
 * poll does not in fact inflate: over 30d that view has 60 + 44 `env:prod`
 * views in the 31s and 32s buckets and ZERO in 10-11s, which is where a 10s
 * poll extending page activity would land its first cycle. That figure was
 * already `env:prod` when taken, and the stage contamination described below
 * cannot reach it in any case — this view has no `env:stage` traffic in those
 * buckets at all. Lowering the floor to 10s would newly withdraw ~32 fleet-wide
 * views that no measurement says are inflated.
 */
export const POLL_INFLATED_LOADING_TIME_FLOOR_MS = 30_000;

/**
 * Datadog's own attribute namespace (`@context.*`), so snake_case rather than
 * the repo's camelCase identifier convention — the same reason
 * `RUM_VIEW_RANGE_ATTRIBUTE` is spelled this way.
 *
 * WRITTEN VALUE (ISS-9711, Perrin Upcott 2026-09-18): explicit `true`/`false`
 * for a view whose `loading_type` is ratified (see
 * `POLL_INFLATED_LOAD_RATIFICATION`) AND whose `loading_time` was actually
 * measured (see `isMeasuredLoadingTime`), and ABSENT for every other view —
 * an unratified `loading_type`, a ratified type the SDK never usably measured
 * (only `initial_load` waits for the browser load event, so `route_change` can
 * reach here with `loading_time` undefined, and a value that cannot be a
 * duration at all is refused the same way), or any view emitted before this
 * classifier shipped. So `false` means "evaluated, confirmed not inflated";
 * it never means "never evaluated".
 *
 * CONSUMERS: prefer the positive form, `@context.poll_inflated_load:false` —
 * it matches only views the classifier actually evaluated, so it is
 * self-bounding and needs no window start. The negation,
 * `-@context.poll_inflated_load:true`, ALSO matches every view that never
 * carried the attribute at all — an unevaluated view and any view that
 * predates the tag alike — because a Datadog negation also matches an event
 * that never carried the attribute. So a range that reaches back before the
 * tag shipped silently readmits the inflated population it claims to have
 * removed, and reads as corrected while it is not. If a query must use the
 * negation, bound it at the first tagged view. Any ranking published from
 * this tag states that window start beside the number.
 *
 * That bound does NOT make the two spellings interchangeable, because they
 * differ by POPULATION and not only by window. Inside any window, `:false`
 * admits evaluated views alone, so it drops every view the classifier left
 * absent — an unratified `loading_type` (`session_renewal`, `bf_cache`, or
 * none at all) and a ratified type whose `loading_time` was never usably
 * measured — all of which the negation keeps. So a per-page ranking that
 * switches spellings moves on a denominator change that is nowhere in its own
 * query diff. Read such a move as the population changing under it until a
 * count of each spelling says otherwise, never as a real improvement.
 *
 * That bound is PER-ENVIRONMENT: RUM `version` comes from each Vercel build, so
 * every environment ships the tag on its own schedule. For `env:prod` it is
 * `2026-09-08T18:02:30.989Z` (ISS-9711), on `version:9c486b4e1c` — the earliest
 * INDEXED tagged view, not provably the earliest emitted one. Use it to the
 * millisecond: truncating it down to the second reopens the sub-second gap the
 * bound exists to close, because the negation readmits anything before it. No
 * other environment has a bound yet — measured 2026-09-10, all 56 tagged views
 * on record are `env:prod` and none are `env:stage` or `env:preview` — so a
 * non-prod ranking must measure its own before it can rely on the negation.
 *
 * POPULATION: ISS-9718 widened what carries this tag on 2026-09-09, from
 * `initial_load` alone to `initial_load` + `route_change` (see
 * `POLL_INFLATED_LOAD_RATIFICATION`). A consumer query that did not change
 * therefore excludes ~47 more `env:prod` views per 30d than it did before that
 * deploy. A ranking recomputed across the deploy moves for a reason that is not
 * in the consumer's own diff, so read any before/after against the deploy
 * rather than against the query.
 */
export const RUM_POLL_INFLATED_LOAD_ATTRIBUTE = "poll_inflated_load";

/**
 * A floor rather than the ticket's ±2s band around each known interval, because
 * the band is wrong-sided: inflation is `interval + the poll request's own
 * duration`, so ±2s around 30s misses the ~32.1s median AC1 names.
 *
 * ISS-9718 re-measured this over 30d of `env:prod` `initial_load` (n=1,219) and
 * KEPT the floor. The population is bimodal with its trough at the floor — 195
 * views below 10s, 24 in 25-30s, 966 at or above it — and no band beats the
 * floor at any upper edge, because the above-floor mass is homogeneous: every
 * sub-bucket carries the same fleet-wide spread over 21 view names, so an edge
 * at 32s/40s/60s readmits 469/54/10 inflated views to rescue a genuinely-slow
 * population the controls cannot find. Do not re-litigate the band without new
 * data. The "99.3% below 10s over 7d of prod" figure previously stated here did
 * not describe prod. Measured at 7d, prod alone is 28.2% below 10s (70 of 248)
 * while `env:stage` is 98.7% (3,534 of 3,579); an unfiltered `service:cl-app`
 * query is ~93% stage by volume, so it reports stage.
 *
 * A genuinely >=30s load is indistinguishable here and is tagged too. That is
 * the honest trade: the tag withdraws the value from load rankings, it does not
 * delete it, so such a view stays queryable rather than silently reading fast.
 * ONE control puts that population near zero: within prod's own above-floor
 * views the browser `load` event has already fired by 2.48s at p95. `env:stage`
 * is NOT the second control an earlier draft of this paragraph claimed. It puts
 * 3 of 15,808 `initial_load` views at or above 30s — 0.019% against prod's
 * 79.2% — and a ~4,000x gap on the very mechanism under study says the two
 * populations are not comparable (short automated stage sessions settle long
 * before a first poll cycle could fire), which disqualifies stage as a control
 * rather than supporting one. It also carries no `version` constraint, so it
 * does not establish that stage ran the prod bundle. Kept as a measurement,
 * not as evidence.
 */
export function isPollInflatedLoadingTime(
  loadingTimeNanoseconds: number | undefined
): boolean {
  if (!isMeasuredLoadingTime(loadingTimeNanoseconds)) {
    return false;
  }

  return (
    loadingTimeNanoseconds / NANOSECONDS_PER_MILLISECOND >=
    POLL_INFLATED_LOADING_TIME_FLOOR_MS
  );
}

/**
 * The loading types the tag is ratified over, and the classification of every
 * other value the wire schema admits.
 *
 * `trackLoadingTime` does NOT compute `loading_time` identically across them:
 * only `initial_load` sets `isWaitingForLoadEvent`, so it waits for the browser
 * load event and folds it into the `Math.max` over candidates, while every other
 * loading type gets the activity-settle candidate alone and stays UNDEFINED if
 * no post-start activity is recorded. What they do share is the inflation path —
 * `waitPageActivityEnd` is called without a `maxDuration` whatever the
 * `loading_type`, so the activity candidate is unbounded on all of them, and at
 * the 30s floor it is the `Math.max` winner regardless. That shared unbounded
 * candidate is why the poll can inflate a route change; it is not a claim that
 * the two are computed the same way.
 *
 * What is per-population is the EVIDENCE, and therefore the ratification; this
 * table tracks the latter, not the mechanism.
 *
 * `route_change` was added on Perrin Upcott's ruling of 2026-09-09 (ISS-9718),
 * superseding the note ISS-9711 left here that the extension was supported by
 * evidence but stayed unratified. The measurement is over the full 30d RUM
 * retention window: 47 of 4,894 timed `env:prod` route changes sit at or above
 * the floor (0.960%), spread over 10 view names — topped by the same page as
 * the `initial_load` mass (`/[orgSlug]/issues/[slug]`) and less concentrated on
 * it, 34% against 54%. Fleet-wide, not one page's artifact. ISS-9711's own
 * reading of the same gap, 47 of 4,875, reproduces that within a day of window
 * slide.
 *
 * It rests on that prod distribution and spread, NOT on a control: an earlier
 * draft netted it against an `env:stage` base rate, and ISS-9711 withdrew that
 * subtraction as uncomparable (see `isPollInflatedLoadingTime`). The one
 * surviving control there — the browser `load` event already fired by 2.48s at
 * p95 — is `initial_load`-only BY CONSTRUCTION, since a route change has no
 * load event to fire. Do not reinstate either as evidence for this row.
 *
 * `session_renewal` is deliberately OUT, and not by oversight. Its mechanism is
 * the same, but nothing measured covers it: 2 of 293 timed prod views over the
 * same window is too small to separate a real excess from noise, and neither
 * control above can be applied to net it. Leaving it out under-tags ~2 views per
 * 30d, stated here; taking it in would widen what the tag withdraws on a
 * measurement that never covered it, which is exactly what this table exists to
 * refuse. `bf_cache` is the fourth loading type rum-core 7.2.0 can emit in a
 * browser and is out on the same rule at n=0 across every env. It is NOT
 * config-gated — `trackViews` starts one on any persisted `pageshow` — so it is
 * unobserved here rather than impossible, and a population appearing later is a
 * reason to re-measure.
 *
 * An absent `loading_type` stays unclassified for the same reason: 1 prod view
 * over 30d, with no population to measure.
 *
 * The six remaining rows are mobile-only (`activity_*`, `fragment_*`,
 * `view_controller_*`) and this browser SDK cannot emit them. They are written
 * out rather than defaulted because the annotation is what makes the table
 * exhaustive: an SDK upgrade that adds an eleventh value fails `tsc` here
 * instead of falling silently to `false`.
 */
export const POLL_INFLATED_LOAD_RATIFICATION: Record<
  NonNullable<RumViewEvent["view"]["loading_type"]>,
  boolean
> = {
  initial_load: true,
  route_change: true,
  session_renewal: false,
  bf_cache: false,
  activity_display: false,
  activity_redisplay: false,
  fragment_display: false,
  fragment_redisplay: false,
  view_controller_display: false,
  view_controller_redisplay: false,
};

/**
 * Whether a view's `loading_type` is one the tag is ratified over. Typed off the
 * call site's own field so an unknown value cannot reach here as a bare string.
 */
export function isPollInflatedLoadingType(
  loadingType: RumViewEvent["view"]["loading_type"]
): boolean {
  if (loadingType === undefined) {
    return false;
  }

  return POLL_INFLATED_LOAD_RATIFICATION[loadingType];
}

/**
 * Whether `loading_time` is a real measurement rather than absent or
 * unusable. `scrubDatadogRumEvent` gates its write on this, not on type
 * ratification alone, so an unusable view stays absent like an unratified one
 * instead of being written `false` — `false` means "evaluated, confirmed not
 * inflated", never "never measured" (ISS-9711 review finding).
 *
 * ABSENT is the ordinary case here, not a fault: only `initial_load` waits for
 * the browser load event, so every other ratified type (`route_change`) gets
 * the activity-settle candidate alone and stays undefined with no post-start
 * activity (see `POLL_INFLATED_LOAD_RATIFICATION`'s docstring).
 *
 * The rest of what is rejected is what a duration CANNOT be, widened from
 * non-finite alone on Marisol Ashgrove's review of PR #7682. Zero and negative
 * are not loads. Neither is a fractional or out-of-safe-range count: rum-core
 * hands `beforeSend` the output of `toServerDuration`, which is
 * `round(durationMs * 1e6, 0)`, so a value outside the safe integers did not
 * come through that serialization and nothing downstream can read it as a
 * duration. `Number.isSafeInteger` rejects those two plus `NaN` and the
 * infinities in one call; the `typeof` conjunct narrows the union for the
 * `> 0` comparison rather than repeating it. Left in, each of these would be
 * written an explicit `false` and read as a confirmed under-floor load.
 */
export function isMeasuredLoadingTime(
  loadingTimeNanoseconds: number | undefined
): loadingTimeNanoseconds is number {
  return (
    typeof loadingTimeNanoseconds === "number" &&
    Number.isSafeInteger(loadingTimeNanoseconds) &&
    loadingTimeNanoseconds > 0
  );
}
