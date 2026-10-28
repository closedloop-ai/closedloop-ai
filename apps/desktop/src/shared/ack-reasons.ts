/**
 * ISS-7486 (#5723 review): the command-ack rejection reasons that were inline
 * string literals at their producers.
 *
 * The six signing rejects and the browser-key and nudge reasons had their own
 * constants — but these seven did not, so the parity guard could only see
 * eleven of the eighteen entries the fold table held then. Renaming any one of
 * them at its producer dropped the server fold to `unknown` with every test
 * still green, which is exactly the drift ISS-7486 exists to stop. ISS-12784
 * has since retired the signing rejects, the browser-key reasons, and the
 * seventh of these, the browser-key revocation failure.
 *
 * Its own module rather than another entry in `contracts.ts`, for the same
 * reason the nudge reasons have theirs: this is one cohesive contract — the
 * wire strings a REJECTED ack can carry — and it is consumed as a
 * unit by `command-ack-rejection-reason-parity.test.ts`, which checks it against
 * the server fold table for SET EQUALITY. That direction matters as much as the
 * other: a fold entry whose producer disappeared is dead mapping, and a producer
 * with no fold entry is a silent `unknown` in prod.
 */
export const COMMAND_ACK_REJECTION_REASONS = {
  /** `validateCommand` — cloud-command-executor. */
  missingCommandId: "commandId is required",
  unsupportedMethod: "unsupported method",
  pathOutsideGateway: "path must start with /api/gateway/",
  /** The gateway command router — app.ts. */
  unroutableOperation: "operationId/path mismatch",
  onboardingIncomplete: "onboarding not completed",
  commandsPaused: "cloud commands paused by user",
} as const;

export type CommandAckRejectionReason =
  (typeof COMMAND_ACK_REJECTION_REASONS)[keyof typeof COMMAND_ACK_REJECTION_REASONS];
