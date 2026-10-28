/**
 * ISS-8241 (Half B): the single cross-surface flag key gating the Branch
 * detail's selected-pull-request BASE REF and AUTHOR.
 *
 * WHAT IT GATES. `pull_request_detail` has carried `base_ref_name` and
 * `author_login` since ISS-8155, but the Branch read never selected either, so
 * the branch's own "What was delivered" pull-request box could name a PR without
 * saying what it targets or who raised it. ON adds both, each with an explicit
 * unmeasured state — a producer that measured neither says so rather than
 * borrowing the owning Branch's current base or leaving a blank that reads as
 * "none". OFF is byte-identical to the box that shipped.
 *
 * NOT `pull-request-row-projection-fields` (ISS-8155). That key gates the PR
 * PICKER row inside the artifact relationships dialog, is web-only by
 * construction, and pairs the base ref with a checks rollup. This one gates the
 * Branch detail box, mounts on both surfaces, and pairs the base ref with the
 * author. Reusing that key would silently widen a shipped web-only gate to
 * desktop and tie two unrelated surfaces to one switch.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both surfaces import the SAME literal instead of
 * redeclaring it — the ISS-5841 arrangement, where byte-equality is a fact of
 * the import rather than a comment two files must keep agreeing on:
 *  - the web app resolves it per-viewer through PostHog, via
 *    `BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY`
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
 * `BranchDeliveredPanel` mounts on BOTH surfaces, so both reading THIS literal
 * means a rename cannot split the two surfaces' reads of it and leave the two
 * fields visible on one surface and hidden on the other. Default OFF on both
 * (ISS-4779 closed-by-default).
 */
export const BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY =
  "branch-detail-pr-base-and-author" as const;
