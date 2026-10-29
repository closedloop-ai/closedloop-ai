/**
 * ISS-12552 (PRD-800 "Rollout"): the one PostHog key that gates
 * everything PRD-800 adds, on the server and on Desktop. A company group flag,
 * evaluated per organization by `apps/api`; the Desktop assignment endpoint
 * evaluates it for the signed-in account's organization, and Desktop's main
 * process turns that answer into its parse policy.
 */
export const ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY =
  "attribution-evidence-policy" as const;
