/**
 * The PostHog flag key gating the Pensero TEAM IDENTIFIERS field inside the
 * Pensero credential card (ISS-8761, closed-by-default per ISS-4779). The card
 * sits on the Settings v2 API Keys panel since ISS-10316.
 *
 * ## Why a second key rather than reusing `pensero-integration`
 *
 * That flag gates whether the CARD exists at all, and it is already on for
 * whoever is in the credential rollout. Adding a new field inside the card is
 * its own end-user-perceivable change, and folding it under the existing key
 * would ship it, on, to every org already in that rollout the moment this
 * deploys — closed-by-default has to mean this change, not a change somebody
 * enabled a month ago.
 *
 * ## One key for web and desktop
 *
 * Same as `pensero-integration`: the panel renders in both shells and the
 * desktop renderer resolves this same PostHog key, so it gates both.
 *
 * ## What it gates, and what it does NOT
 *
 * The FIELD only. With the flag off the card renders exactly as it did before:
 * token and endpoint, no team-identifiers input. The route accepts the field
 * independently of this flag — a flag is a rollout control, never an
 * authorization boundary, and the `PUT` is already admin-gated and already
 * behind the credential rollout gate.
 *
 * With the flag off an org's stored narrowing is neither shown nor editable but
 * is still HONOURED by the scheduler. That is deliberate: silently ignoring a
 * value an admin set, because a display gate is off, would make the poll cover
 * teams they excluded.
 *
 * ## The flag must exist in PostHog before it can be enabled
 *
 * Declaring this constant creates nothing in PostHog. `useFeatureFlag(KEY)`
 * returns `undefined` for a key PostHog has never heard of, which folds to
 * `false` — the safe direction for a closed-by-default gate, and the reason
 * enabling this needs the flag created there first.
 */
export const PENSERO_TEAM_IDENTIFIERS_FLAG_KEY =
  "pensero-team-identifiers" as const;
