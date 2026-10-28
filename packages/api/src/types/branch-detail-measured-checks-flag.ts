/**
 * ISS-8241 (Half A): the single cross-surface flag key gating the Branch
 * detail's selected-pull-request checks being served from the MEASURED
 * projection instead of a live GitHub read.
 *
 * WHAT IT GATES. WHICH ANSWER the "Checks & review" box states — not whether the
 * server reads GitHub. The Branch detail route performs its live acquisition
 * either way, because the response keeps serving `selectedPullRequestChecks` for
 * the flag-off render; this key only decides whether the box reads that live
 * answer or the stored current-head projection, which is served only while it was
 * written at that pull request's own `headRefOid`. ON, the box also names each
 * non-answer apart: a measured empty population, a measured read that FAILED, a
 * measured population whose rows did not come back, and a head no producer
 * reached. OFF is byte-identical to the live box that shipped.
 *
 * DESKTOP LOCAL MODE HAS NO PRODUCER FOR IT. The local SQLite Branch detail
 * builds its own response and never fills the projection, so with this on and a
 * local source selected every branch reads "Checks not reported" — which is
 * true, and is why the flag's description says where the value comes from.
 *
 * THE ACCEPTED COST, ruled by Perrin on 2026-08-27: with it on, a check that
 * flipped since the last projection write does not show until the projection
 * updates. That was decided knowingly and is not to be bought back with a
 * freshness note, a refresh control, or a live-versus-measured switch.
 *
 * NOT `branch-detail-pr-base-and-author` (ISS-8241 Half B). That key gates two
 * ADDED provenance lines in the delivered-work box and rides its own rollout;
 * this one changes where an existing box's checks come from. One key for both
 * would mean a reader could not get the honest checks without also taking the
 * new lines, and neither half could be rolled back alone.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both surfaces import the SAME literal instead of
 * redeclaring it — the ISS-5841 arrangement, where byte-equality is a fact of
 * the import rather than a comment two files must keep agreeing on:
 *  - the web app resolves it per-viewer through PostHog, via
 *    `BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`);
 *  - the desktop renderer resolves THAT SAME literal from the signed-in
 *    account's PostHog assignment — the same key space the web app reads — so
 *    the two surfaces cannot diverge. The constant is imported directly into
 *    `SHARED_UI_FEATURE_FLAGS`
 *    (`apps/desktop/src/shared/feature-flags-shared-ui.ts`), which owns the
 *    desktop default-off settings metadata rather than the renderer's read.
 *    No `DESKTOP_…` alias is minted for it: a second name would be one more
 *    thing that can drift from this literal.
 *
 * `BranchPrStatusPanel` mounts on BOTH surfaces, so both reading THIS literal
 * means a rename cannot split the two surfaces' reads of it and leave one
 * surface on the live read while the other is on the measured one. Default OFF
 * on both (ISS-4779 closed-by-default).
 */
export const BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY =
  "branch-detail-measured-checks" as const;
