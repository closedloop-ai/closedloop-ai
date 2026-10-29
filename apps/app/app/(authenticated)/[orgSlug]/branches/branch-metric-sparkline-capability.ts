/**
 * ISS-10544 — the WEB host's answer to "does this shell serve the Branches
 * metric-card trend sparkline?", and it is an unconditional yes.
 *
 * GRADUATED, by the operator's ruling of 2026-09-17.
 * `branches-metric-card-trend-sparkline` stays a key — the desktop renderer
 * still resolves it — but it no longer decides anything here, so there is
 * nothing on this shell left to flip. That is deliberate rather than
 * incidental: ISS-10363 shipped the series, the gap handling and the producer
 * work to compute it, and every web reader then got `undefined` in the
 * `sparkline` slot because the gate behind it was never opened.
 *
 * What authorises shipping this at 100% on web is the operator ruling above,
 * and nothing else. It is NOT an instance of AGENTS.md's retirement clause:
 * that clause covers retiring a flag whose behavior has ALREADY SHIPPED, and
 * this gate never resolved true for anyone in production (tamsinb, #7525). So
 * do not read this module as a precedent for deleting a never-rolled-out flag
 * and shipping its surface — that still takes a ruling of its own.
 *
 * A CONSTANT, not a literal at the mount, so this shell's answer is a thing a
 * test can hold. A `true` written inline in `page.tsx` is indistinguishable from
 * a component that always draws the mark, which is precisely the confusion a
 * per-host capability exists to end.
 *
 * The desktop half is `useDesktopBranchMetricSparkline` in
 * `apps/desktop/src/renderer/feature-flags/`, which reads the key at its own
 * read site and answers no until it resolves true.
 */
export const WEB_BRANCH_METRIC_SPARKLINE = true;
