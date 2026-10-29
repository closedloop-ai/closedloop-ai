/**
 * @file identity-bound-compute-target.ts
 * @description ISS-11467: the one fold that turns a raw, strict-online compute
 * target into one the signed-in account is known to own.
 *
 * There are two resolvers behind every sync lane, and only one of them carries
 * the owner check. `sessionSyncIdentity.computeTargetId()` is the identity-bound
 * live-else-retained read and refuses a KNOWN-foreign id locally
 * (`retained-compute-target-identity.ts`, `belongsToAnotherAccount`);
 * `onlineComputeTargetId()` names whatever target the socket is reporting, with
 * no identity check at all. Measured 2026-09-28 over 24h, the lanes wired to the
 * second one carried every `target_not_owned` refusal worth counting —
 * `invocation_parts` 550, `transcript_archive` 353, `component_inventory` 4 —
 * against 3 for the one lane that consults the check. A refusal the client can
 * already see is a round trip and a deferral spent on nothing.
 *
 * Reporting only when the two AGREE is what binds the online id without making
 * the local guard stricter, and that distinction is the whole design:
 *
 * - Online under one identity: the two are equal, so this returns exactly what
 *   the raw read did. Unchanged.
 * - Hello before auth (no account recorded yet): the identity-bound resolver
 *   ADOPTS the live id, so the two are equal here too and the lane keeps
 *   running. Guessing "not this account" from an absent account is what would
 *   dark the lane on an ordinary start-up, and it is deliberately not done —
 *   `retained-compute-target-identity.ts:336` states that boundary.
 * - Offline or mid-flap: the online read is null, so this is null, which every
 *   lane already reads as "no identity yet" rather than as an empty queue.
 * - KNOWN foreign (an account switch that left the socket up): the
 *   identity-bound resolver is null while the online one still names the
 *   previous account's target. They disagree, and the id never leaves the
 *   machine. This is the case the ticket exists to close.
 *
 * Pure and parameterized rather than reading the adapter itself, because the two
 * callers reach the same two values by different routes — the lane composition
 * through `DesktopSyncLaneDeps`, the transcript lane through
 * `DesktopApplication` — and a second copy of the comparison is how the lanes
 * would come to disagree about what "owned" means.
 */

export function identityBoundComputeTargetId(
  onlineComputeTargetId: string | null,
  identityBoundSyncComputeTargetId: string | null
): string | null {
  return onlineComputeTargetId !== null &&
    onlineComputeTargetId === identityBoundSyncComputeTargetId
    ? onlineComputeTargetId
    : null;
}
