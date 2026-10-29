/**
 * ISS-10422 (PRD-714) — the closed-by-default production adoption gate for the
 * Universal Artifact Status champion.
 *
 * Production adapters read this key directly at their owning render swaps and
 * choose a complete legacy or champion shape. They do not pass the boolean
 * through component props or hide it behind a boolean-returning wrapper, so the
 * feature-flag source gate can inventory every adoption site.
 *
 * Web and Desktop use this same PostHog key. Desktop resolves the signed-in
 * account's assignment from the web key space; there is no Labs shadow key or
 * build-type fallback. The live rollout percentage is PostHog's, not this
 * module's: read it from the key, and take rollout decisions to ISS-10422
 * (PRD-714).
 *
 * `artifact-status-label-honesty` remains an independent copy rollout. This key
 * selects the shared component; the honesty key decides whether unknown-status
 * explanatory copy is exposed.
 *
 * This dependency-free `@repo/api` module is safe for bundle-sensitive client
 * adapters and for displayless Electron E2E imports.
 */
export const UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY =
  "universal-artifact-status" as const;
