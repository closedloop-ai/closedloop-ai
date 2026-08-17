import type { ToneLabelVariant } from "@closedloop-ai/design-system/components/ui/tone-label";
import {
  TranscriptEgressGate,
  TranscriptSyncStatus,
  type TranscriptSyncStatusSnapshot,
} from "../../../shared/transcript-sync-status-contract";

/**
 * ISS-4716: what the import-splash footer says about transcript sync.
 *
 * The footer used to be a hardcoded text node — "Computed on this device · 0
 * bytes uploaded" under a green shield — rendered in every phase and under every
 * sync tier. It lied three ways: the byte figure could never be anything but
 * zero, the green shield read as a privacy guarantee while the app was trying
 * and failing to upload, and it could not tell a user who had never connected
 * apart from one whose uploads were dead-lettering.
 *
 * Two rules keep the replacement honest, and both are load-bearing:
 *
 * 1. **No completion claim, in either direction.** The snapshot's
 *    `statusCounts` is a whole-table census (ISS-5348 replaced a newest-100
 *    sample that could hide older dead-lettered rows), so it says exactly which
 *    lifecycle states have rows RIGHT NOW — and nothing about what has already
 *    left the device. `idle` covers both "uploaded" and "never had anything to
 *    upload", and rows are a queue/cache that is pruned and rebuilt, not a
 *    history. So an all-`idle` table still may not assert that everything
 *    uploaded; `Enabled` states the *configuration* ("transcripts sync to your
 *    workspace"), never the outcome. The negative direction is a claim too: a
 *    "nothing uploaded" reassurance would be false for anyone who synced at the
 *    `full` tier for months and later lowered it, since the snapshot carries no
 *    history. That is why `Disabled` says "upload is off", not "nothing left
 *    this device", and why no state carries a success tone.
 *
 * 2. **Every `shouldRun()` precondition outranks every activity row.** The
 *    service drains only when `tierAllowsSync() && isEnabled() && isOnline() &&
 *    store` all hold. If any is false the lane cannot tick, so a row below them
 *    must never claim work is happening. The one exception is a TERMINAL
 *    failure: `dead` is written only under `shouldRun()`, so a `dead` row seen
 *    while offline was necessarily produced during an earlier online episode —
 *    it is true, permanent, and unaffected by connectivity, so it outranks
 *    `!online` rather than being suppressed by it.
 */
export const SyncFootnoteState = {
  /**
   * The status read has not resolved yet — renders a skeleton, never text.
   * Also covers the online-and-signed-in window where the org policy is still
   * in flight, which is a pending read like any other.
   */
  Loading: "loading",
  /** The read failed, the bridge is absent, or the DB is not up. Renders NOTHING. */
  Unavailable: "unavailable",
  /** The user's own `transcriptSyncEnabled` toggle is off. */
  Disabled: "disabled",
  /** A SETTLED consent-tier or org-policy denial. Never the unresolved window. */
  Inactive: "inactive",
  /** No relay compute target / not signed in, so the drain cannot tick. */
  NotConnected: "notConnected",
  /** At least one transcript is terminally dead-lettered. */
  Failed: "failed",
  /** At least one transcript row is claimed for upload. */
  Uploading: "uploading",
  /** At least one transcript row is queued behind the drain. */
  Queued: "queued",
  /** At least one transcript failed transiently and will be retried. */
  Retrying: "retrying",
  /** Sync is configured and operative; nothing observed in the window. */
  Enabled: "enabled",
} as const;
export type SyncFootnoteState =
  (typeof SyncFootnoteState)[keyof typeof SyncFootnoteState];

/**
 * The renderer's view of the status read. A discriminated union rather than a
 * nullable snapshot, so "not read yet" and "read failed" can never collapse
 * into each other or into a real all-zero `statusCounts` — the exact conflation
 * this ticket exists to remove.
 */
export type TranscriptSyncStatusRead =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; snapshot: TranscriptSyncStatusSnapshot };

/**
 * `Record`-keyed so a new {@link SyncFootnoteState} member fails typecheck here
 * until it is given a label, rather than rendering blank.
 */
export const SYNC_FOOTNOTE_LABELS: Record<SyncFootnoteState, string> = {
  // Deliberately empty: `Loading` renders a skeleton. Copy that appears and then
  // disappears is itself a reflow, and a visible string would invite mistaking
  // a not-yet-read status for a settled one.
  [SyncFootnoteState.Loading]: "",
  // Also deliberately empty (ISS-5348 review): this state means the read did not
  // land, which is a fact about US, not about the user's uploads. Printing
  // "Upload status unavailable" in a boot splash answers a question nobody
  // asked, and does it with a non-answer. Saying nothing is the honest render —
  // it makes no claim in either direction.
  [SyncFootnoteState.Unavailable]: "",
  // ISS-5348 (review): ATTRIBUTED, unlike the two below, because this is the one
  // the user owns and can undo. "Transcript upload is off" sat beside "isn't
  // active" and "isn't connected" as a third indistinguishable way of saying
  // nothing is happening, when only this one is their own switch.
  [SyncFootnoteState.Disabled]: "You turned transcript upload off",
  // Non-attributive on purpose: a settled denial is either a consent tier that
  // does not permit transcripts or an org policy that forbids them, and the
  // renderer cannot tell which. It no longer covers the unresolved window —
  // that is `Loading` now — so this is a real verdict, just not an itemized one.
  [SyncFootnoteState.Inactive]: "Transcript upload isn't active",
  [SyncFootnoteState.NotConnected]: "Transcript upload isn't connected",
  [SyncFootnoteState.Failed]: "Some transcripts couldn't be uploaded",
  // Pending-framed rather than instantaneous: a crash mid-upload leaves rows at
  // status `uploading` until the boot-time `requeueStale` re-arm, which can
  // trail by a full sweep interval. "In progress" is true both for a transfer
  // actually on the wire and for a claimed row awaiting re-arm.
  [SyncFootnoteState.Uploading]: "Transcript uploads are in progress",
  [SyncFootnoteState.Queued]: "Transcripts queued to upload",
  [SyncFootnoteState.Retrying]: "Retrying some transcript uploads",
  // Configuration, not outcome — see rule 1 in the module docblock.
  [SyncFootnoteState.Enabled]: "Transcripts sync to your workspace",
};

/**
 * Tone per state, as design-system `Badge`/`Chip` variants so the colour comes
 * from the one canonical variant→text-colour map (`ToneLabel`) instead of a
 * second one declared here.
 *
 * Only a genuine problem is coloured. Nominal states stay `muted` so a healthy
 * lane is not a wall of badges — and, critically, NO state is `success`: a green
 * reassurance is what made the original copy read as a privacy guarantee it had
 * not earned.
 */
export const SYNC_FOOTNOTE_TONES: Record<SyncFootnoteState, ToneLabelVariant> =
  {
    [SyncFootnoteState.Loading]: "muted",
    [SyncFootnoteState.Unavailable]: "muted",
    [SyncFootnoteState.Disabled]: "muted",
    [SyncFootnoteState.Inactive]: "muted",
    [SyncFootnoteState.NotConnected]: "muted",
    [SyncFootnoteState.Failed]: "warning",
    [SyncFootnoteState.Uploading]: "muted",
    [SyncFootnoteState.Queued]: "muted",
    [SyncFootnoteState.Retrying]: "muted",
    [SyncFootnoteState.Enabled]: "muted",
  };

function hasStatus(
  snapshot: TranscriptSyncStatusSnapshot,
  status: TranscriptSyncStatus
): boolean {
  return snapshot.statusCounts[status] > 0;
}

/**
 * Map a status read to the footnote state. Total over its input; see the module
 * docblock for why the precondition rows come first and why the terminal-failure
 * row is the one thing that outranks `!online`.
 *
 * A `status` string outside the known union (a version-skewed or corrupt row)
 * matches no predicate and falls through to `Enabled`, the claim-free state —
 * it never throws.
 */
export function deriveSyncFootnoteState(
  read: TranscriptSyncStatusRead
): SyncFootnoteState {
  if (read.state === "loading") {
    return SyncFootnoteState.Loading;
  }
  if (read.state === "unavailable") {
    return SyncFootnoteState.Unavailable;
  }
  const { snapshot } = read;
  if (!snapshot.enabled) {
    return SyncFootnoteState.Disabled;
  }
  if (snapshot.tierGate === TranscriptEgressGate.Denied) {
    return SyncFootnoteState.Inactive;
  }
  if (!snapshot.storeReady) {
    return SyncFootnoteState.Unavailable;
  }
  // Terminal before transient: a dead-lettered transcript is a permanent fact
  // produced while the lane WAS running, so going offline must not hide it.
  if (hasStatus(snapshot, TranscriptSyncStatus.Dead)) {
    return SyncFootnoteState.Failed;
  }
  if (!snapshot.online) {
    return SyncFootnoteState.NotConnected;
  }
  // ISS-5348 (review): an unresolved org policy is checked HERE, not up beside
  // the settled `Denied`, and the placement is the whole fix.
  //
  // The store is born `Unknown` and only a successful identity fetch resolves
  // it — there is no timeout and no give-up. So a signed-out or permanently
  // offline device sits at `Unknown` forever, and holding a skeleton there
  // would be its own lie: a spinner that never lands. Those devices are exactly
  // the ones `!online` catches one line above, where `NotConnected` is both
  // true and settled.
  //
  // What reaches this line is the case the reviewer flagged: online, signed in,
  // and the policy simply has not come back yet — a window that closes in
  // seconds (refresh fires on cloud-online, self-heal retries every 30s). A
  // skeleton is the honest render for that, and it sits ABOVE the activity rows
  // because the lane cannot drain on an unresolved gate, so no row below may
  // claim work is happening.
  if (snapshot.tierGate === TranscriptEgressGate.Unresolved) {
    return SyncFootnoteState.Loading;
  }
  if (hasStatus(snapshot, TranscriptSyncStatus.Uploading)) {
    return SyncFootnoteState.Uploading;
  }
  if (hasStatus(snapshot, TranscriptSyncStatus.Queued)) {
    return SyncFootnoteState.Queued;
  }
  if (hasStatus(snapshot, TranscriptSyncStatus.Failed)) {
    return SyncFootnoteState.Retrying;
  }
  return SyncFootnoteState.Enabled;
}
