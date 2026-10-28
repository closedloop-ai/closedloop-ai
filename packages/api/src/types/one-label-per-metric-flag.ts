/**
 * ISS-10667: the single cross-surface flag key gating one spelling per metric.
 *
 * DOC-27 R4a ruled one spelling for the LOC-per-dollar ratio; the operator
 * extended that to every metric on 2026-09-18, which retires `cost`, `Cost`,
 * `Spend`, `Tokens`, `Total Tokens`, `total tokens`, `LOC / $`, `LOC/$` and
 * `LOC per $` in favour of four labels.
 *
 * ONE key for the whole vocabulary and for every surface, for the reason the
 * retired `total-estimated-cost-metrics` key stated before it: the Sessions strip,
 * the Branches strip, the Dashboard KPI row, the Insights tiles and the Session
 * detail panes all mount from `@repo/app` on the web shell and the desktop
 * renderer alike, and the desktop resolves the signed-in account's PostHog
 * assignment from the same key space the web reads. A per-surface key is how
 * half a vocabulary ships while the other half stays dark — which is the drift
 * this decision exists to end.
 *
 * WHAT IT DOES NOT REACH, and why that is not the drift above: a surface whose
 * figure's BASIS is still unestablished. Relabelling one asserts a basis nobody
 * measured, so a column that sums input + output cannot take `Total tokens`
 * until something settles what it counts. ISS-10691 holds that tranche and
 * settles each basis before its label moves.
 *
 * Default OFF.
 */
export const ONE_LABEL_PER_METRIC_FLAG_KEY = "one-label-per-metric" as const;
