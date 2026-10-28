/**
 * Why `seedPreviewSchema` refused or failed, for the route to pick a status
 * from. `HostNotAllowed` → 403 (the same fail-closed host invariant as ensure);
 * `NotAPreviewSchema` → 400 (the derived name is not `preview_*`, so the seed
 * would land somewhere it must never write); `AlreadyRunning` → 409 (a peer
 * holds this schema's admission lock, so the identical work is already in
 * flight); `Failed` → 500.
 *
 * Not a wire value; the client gets a generic message and this is how the
 * server tells the causes apart (same posture as `EnsureFailureReason`).
 */
export const SeedFailureReason = {
  HostNotAllowed: "host_not_allowed",
  NotAPreviewSchema: "not_a_preview_schema",
  AlreadyRunning: "already_running",
  Failed: "failed",
} as const;

export type SeedFailureReason =
  (typeof SeedFailureReason)[keyof typeof SeedFailureReason];
