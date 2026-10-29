/**
 * ISS-5081: the owner vocabulary for integration tokens. The
 * `data.invariant.integration_tokens_*` gauge labels its backlog by owner.
 */

/**
 * Which integration's token is counted. A closed, code-owned set, never
 * caller-supplied, so it is safe as a Datadog label.
 */
export const IntegrationTokenOwner = {
  Google: "google",
  Linear: "linear",
  Slack: "slack",
} as const;
export type IntegrationTokenOwner =
  (typeof IntegrationTokenOwner)[keyof typeof IntegrationTokenOwner];
