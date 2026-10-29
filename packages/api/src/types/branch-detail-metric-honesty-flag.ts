/**
 * ISS-6954 / ISS-6955 / ISS-6957 / ISS-6958: the single cross-surface flag key
 * gating the Branch detail screen's outcome presentation.
 *
 * WHAT IT GATES. Four renders that each state something the evidence does not
 * support, fixed together because they are one screen's account of one outcome:
 *  - the outcome metric is named ONCE (as "Cycle Time"), by the headline card,
 *    instead of the card and the waterfall below it naming the same measurement
 *    in two treatments (ISS-6954);
 *  - the waterfall's heading no longer hard-codes the merged-outcome label on a
 *    branch that never merged (ISS-6955);
 *  - a pull-request-cycle card with no selected pull request names THAT as the
 *    reason instead of reporting an evidence outage (ISS-6957);
 *  - durations scale through hours and days and drop a zero-seconds component,
 *    so 53 hours reads "2d 5h" rather than "3180m 0s" (ISS-6958).
 * OFF is byte-identical to what shipped.
 *
 * ONE KEY, NOT FOUR, because they are not independently shippable: the rename
 * is what makes the duplicate heading removable, and the heading is the same
 * string ISS-6955 fixes. Splitting them would let a reader take the rename
 * without the de-duplication and see two differently-named cards for one
 * measurement — worse than either state alone.
 *
 * SCOPED TO THE PULL-REQUEST-CYCLE METRICS. "LOC per $" is Branch-LIFETIME
 * scoped and its own tooltip says selecting a pull request does not change it,
 * so the PR-less reason is NOT applied to it: naming a pull request as the
 * blocker for a metric that does not depend on one would replace one wrong
 * sentence with another.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both surfaces import the SAME literal instead of
 * redeclaring it — the ISS-5841 arrangement:
 *  - the web app resolves it per-viewer through PostHog, via
 *    `BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`);
 *  - the desktop renderer resolves THAT SAME literal from the signed-in
 *    account's PostHog assignment — the same key space the web app reads — so
 *    the two surfaces cannot diverge. The constant is imported directly into
 *    `SHARED_UI_FEATURE_FLAGS`
 *    (`apps/desktop/src/shared/feature-flags-shared-ui.ts`), which owns the
 *    desktop default-off settings metadata rather than the renderer's read.
 *
 * `BranchHeadlineCards` and `BranchLeadTimeWaterfall` mount on BOTH surfaces
 * from `packages/app`, so both reading THIS literal is what stops a rename from
 * splitting the two surfaces' reads of it and leaving one surface naming the
 * metric twice. Default OFF on both (ISS-4779 closed-by-default).
 */
export const BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY =
  "branch-detail-metric-honesty" as const;
