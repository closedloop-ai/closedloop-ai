/**
 * FEA-3570 — the single cross-surface flag key gating the GitHub logo's move
 * from lucide's outline `Github` glyph to the filled Invertocat `GitHubMark`
 * (`packages/design-system/components/ui/brand-icons.tsx`).
 *
 * ## Why a flag at all
 *
 * ISS-4779 closes UI by default, and the exempt classes do not reach this
 * change. It is not copy, and not a single-surface change: fifteen shipped call
 * sites across eleven files in `apps/web`, `apps/app`, and `packages/app`, and
 * the `packages/app` half reaches BOTH the web app and the packaged desktop
 * renderer. Nor does it restore an earlier intent — `GitHubMark` arrived in
 * 3b204c92b behind `unified-auth-onboarding` and has never rendered at these
 * eleven sites, so every one of them is a forward visual change rather than a
 * regression repair.
 *
 * ## Why ONE key across three surface families
 *
 * One key, so a rollout cannot open on one shell and not the other: flag OFF
 * leaves today's outline on every gated surface, flag ON fills them together.
 * Two keys is
 * exactly how a mark flips on one surface and not another, which for a brand
 * logo is the whole defect being fixed. The desktop renderer resolves the
 * signed-in account's PostHog assignment from the same key space as `apps/app`,
 * so one key covers it with no desktop Labs toggle and no desktop registry
 * shadow entry (operator directive 2026-08-30).
 *
 * Two hooks read this one key, because the surface families have different flag
 * ports and `apps/web` does not depend on `@repo/app`:
 *  - `packages/app` and `apps/app` read it through the injected adapter
 *    (`useFeatureFlagEnabledOptional`), re-exported as
 *    `GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY` in
 *    `packages/app/shared/lib/feature-flags.ts`.
 *  - `apps/web` reads it through `@repo/analytics/client`, whose
 *    `AnalyticsProvider` the marketing layout already mounts.
 *
 * ## Why both readers gate on having mounted
 *
 * Four of the five `apps/web` call sites are SERVER components, so the gated
 * mark renders through a small client component. PostHog can answer from
 * bootstrapped local state on the very first client render, so reading the flag
 * during hydration would produce server HTML that disagrees with the first
 * client paint. Both readers therefore render the outline until mounted, which
 * makes the OFF state byte-identical to today's markup on every surface and
 * leaves the swap to a post-hydration render for enabled viewers only.
 *
 * WHOEVER FLIPS THIS KEY SHOULD EXPECT THAT SWAP TO BE VISIBLE. For an enabled
 * viewer the outline paints first and the filled mark replaces it on the render
 * after hydration. On the product surfaces that lands inside a card, but on
 * `apps/web` it is the site header and the hero button above the fold, so it
 * reads as a logo pop on every marketing page load once the rollout is open.
 * That is the accepted cost of keeping the closed state byte-identical — the
 * alternative is a hydration mismatch on anonymous traffic — and the tests pin
 * the two end states rather than the transition between them.
 *
 * ## What this key does NOT reach
 *
 * Desktop PRE-AUTH surfaces resolve it closed however it is rolled out. The
 * desktop port reads the signed-in account's assignment, and every terminal
 * non-answer — signed out included — settles as no flags at all, while
 * `apps/web` can resolve for an anonymous visitor. So the desktop sign-in step
 * keeps the outline until the user signs in. That is the platform's flag
 * mechanism, not a gap in this gate.
 *
 * Two shipped surfaces already render `GitHubMark` UNGATED and keep doing so:
 * the onboarding auth transition panel and the Settings Profile sign-in rows,
 * both through `SIGN_IN_PROVIDER_MARK`. They are already the filled mark this
 * ticket wants everywhere, so gating them would mean rendering them WORSE while
 * the flag is closed. The consequence to know is that flag-OFF is a mixed
 * state — which is what ships today — and flag-ON is what makes the flow
 * consistent. The prototypes and Storybook are likewise ungated, by the
 * policy's own exemption.
 *
 * Lives in this dependency-free `@repo/api` module so every surface can import
 * the same literal without dragging a transitive dependency along.
 */
export const GITHUB_BRAND_MARK_FILLED_FLAG_KEY =
  "github-brand-mark-filled" as const;
