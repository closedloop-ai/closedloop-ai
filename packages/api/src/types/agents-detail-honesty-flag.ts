/**
 * ISS-5518 / ISS-5519 / ISS-5521: the single cross-surface flag key that gates
 * the Agents component detail page saying only what it can back up.
 *
 * Three symptoms, one root shape — the page asserting something its own data
 * does not support:
 *  - IDENTITY (ISS-5518): a content-hash route renders the 64-hex digest in the
 *    header subtitle while the breadcrumb, given the same value, refuses to and
 *    prints the literal "Agent". One screen, two opposite rulings on one value.
 *  - DEAD OPERANDS (ISS-5519): "Lines shipped" and "Total cost" reduce over
 *    `branchesTab` rows the server hardcodes to `additions: null` /
 *    `estimatedCostUsd: null`, so they are permanently `—`; sitting beside the
 *    independently-computed `LOC / $` they read as its unavailable operands and
 *    make a real number look fabricated.
 * ISS-5521's UNDISCLOSED CAP — "Merged PRs" counted over the first
 * {@link COHORT_SCAN_CAP} cohort sessions under a tooltip claiming "every
 * session" — was the third symptom and is NO LONGER gated here. ISS-6462 gave
 * the Packs Performance tile the same disclosure off the same field with no
 * flag, so a gate on this one left the default path with two screens describing
 * one response and only one of them telling the truth.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * `AgentDetail` mounts on the web app AND the packaged desktop renderer, so a
 * single-surface gate would let the change leak on desktop while hidden on web
 * (ISS-4779 closed-by-default). Importing one constant on both sides means a
 * future rename touches a single definition and cannot silently split them.
 */
export const AGENTS_DETAIL_HONESTY_FLAG_KEY = "agents-detail-honesty" as const;
