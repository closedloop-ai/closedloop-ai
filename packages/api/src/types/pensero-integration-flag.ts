/**
 * The PostHog flag key gating the Pensero credential card (ISS-8007,
 * closed-by-default per ISS-4779). ISS-10316 moved the card from the legacy
 * Settings → Integrations tab onto the Settings v2 API Keys panel.
 *
 * ## One key for web and desktop
 *
 * The API Keys panel renders in both shells, and the desktop renderer resolves
 * the signed-in account's PostHog assignment from this same key space. There is
 * no second, desktop-named key and no desktop Labs toggle to pair with it.
 *
 * It still lives in this lightweight, dependency-free `@repo/api` module rather
 * than as a bare string at the call site, so the card and any later consumer
 * import the SAME literal instead of redeclaring it.
 *
 * ## What it gates
 *
 * The card only. With the flag off the API Keys panel renders without it: no
 * Pensero card, no way to reach the credential routes from the UI. The routes themselves are org-admin gated independently of this flag —
 * a flag is a rollout control, never an authorization boundary.
 *
 * ## The flag must exist in PostHog before it can be enabled
 *
 * Declaring this constant creates nothing in PostHog. `useFeatureFlag(KEY)`
 * returns `undefined` for a key PostHog has never heard of, which the
 * `?.enabled === true` idiom folds to `false` — indistinguishable from a
 * deliberate "off". That is the safe direction for a closed-by-default gate
 * (the card stays hidden), but it means enabling this feature requires creating
 * the flag in PostHog first; there is no code change that can substitute.
 */
export const PENSERO_INTEGRATION_FLAG_KEY = "pensero-integration" as const;
