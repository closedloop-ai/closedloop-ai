/**
 * ISS-11397 (@whitlockk): the marketing routes serving the legal pages, owned here
 * rather than by the onboarding slice because two unrelated features read them
 * — the guided-onboarding dialog composes its `target="_blank"` hrefs from
 * them, and `apps/app/app/layout.tsx` hands them to Clerk's sign-up screens.
 * `packages/app/AGENTS.md` puts cross-feature code under `shared/`.
 *
 * They are PATHS, not URLs: each consumer resolves them against the origin it
 * can see, which is not the same variable on both sides.
 */
export const LEGAL_PRIVACY_PATH = "/legal/privacy";
export const LEGAL_TERMS_PATH = "/legal/terms";
