/**
 * Which schema a `/preview-schemas/ensure` request targets (ISS-5984).
 *
 * The literal values are a wire contract: the stage-deploy workflow POSTs
 * `{"target":"public"}` from bash, which cannot import this module, so
 * `scripts/deploy/staging-integration-workflow-source.test.ts` asserts the
 * workflow's literal against this const rather than against a second copy.
 */
export const EnsureTarget = {
  Preview: "preview",
  Public: "public",
} as const;

export type EnsureTarget = (typeof EnsureTarget)[keyof typeof EnsureTarget];

/**
 * Why `ensureSchemaAtHead` refused or failed, for a caller that answers
 * differently per cause. The HTTP route maps `HostNotAllowed` to a 403 and
 * everything else to a 500; the lazy bootstrap gate just throws either way.
 *
 * Not a wire value — it is never serialized into a response body. The client
 * gets a deliberately generic message (ISS-6403, review: wongk); this is how
 * the SERVER tells the two apart.
 */
export const EnsureFailureReason = {
  HostNotAllowed: "host_not_allowed",
  Failed: "failed",
} as const;

export type EnsureFailureReason =
  (typeof EnsureFailureReason)[keyof typeof EnsureFailureReason];
