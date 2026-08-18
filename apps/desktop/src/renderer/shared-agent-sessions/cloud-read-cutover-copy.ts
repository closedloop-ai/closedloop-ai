import { ReadSource } from "@repo/api/src/types/read-source";
import {
  describeUndeliverableItems,
  formatCount,
} from "../components/import-progress-display";
import {
  CloudReadCutoverBlocker,
  type CloudReadCutoverDecision,
  DesktopAppCoreMode,
} from "./desktop-app-core-mode";

/**
 * ISS-5477: the one sentence the read-source badge adds to explain WHY the
 * active source is what it is.
 *
 * Four states have to stay distinct here, because collapsing any two of them is
 * the defect this ticket exists to remove:
 *
 *  - **Local while the backlog drains** — the app is fully usable and this is
 *    the user's real data. Not an error, not an empty state, and it says how
 *    much is left so the wait is legible.
 *  - **Cloud once genuinely drained** — nothing to add; the badge's own tooltip
 *    already says what a cloud read means.
 *  - **Cloud without a drain** (the bounded fail-open, or newly-captured work
 *    after the cutover latched) — say plainly that this view may be missing
 *    what is still on the machine. Never let it read as complete.
 *  - **Given up on** — dead-lettered items will NEVER arrive. That is a
 *    different sentence from "still uploading", and it is named as such.
 *
 * Counts are rendered honestly: a `null` remainder is a lane that could not
 * measure what it owes, so it reads as "some" rather than as a reassuring
 * number that silently omits a lane.
 *
 * Two rules hold across the whole set:
 *
 *  - Every state that reads off the complete local database ends in
 *    `NOTHING_IS_MISSING`. The two states where something genuinely may not
 *    arrive (dead-letter, failed-open) never claim it, and owe a next step
 *    instead.
 *  - The badge sitting next to this sentence already says "Local", so the
 *    strings do not each re-explain whose data this is. Said once, where the
 *    reason itself does not imply it.
 */
export function describeCloudReadCutover(
  decision: CloudReadCutoverDecision,
  readSource?: ReadSource
): string | undefined {
  // ISS-5714 (review thread): a `Fallback` read is the one state where NEITHER
  // store answered, so every sentence below is a claim about a read that did
  // not happen. Left to fall through, an offline fallback reached the local
  // blocker map and printed "Nothing is missing." directly under a badge saying
  // the view may be incomplete — the reassurance is the failure, not the
  // wording. Answered first, and never with `NOTHING_IS_MISSING`.
  if (readSource === ReadSource.Fallback) {
    return `${FALLBACK_SOURCE_UNRESOLVED}${deadLetterSuffix(decision)}`;
  }
  // ISS-5714: a surface reading the CLOUD while the decision blocks on
  // connectivity is a real state — Branches keeps serving its cached canonical
  // rows through an offline window while Sessions drops to local. The offline
  // sentence below is written for the local reader ("this is your own machine's
  // data"), and printing it under a `Cloud` badge is a badge and a denial of
  // that badge in one tooltip: the same defect this ticket fixed on the Median
  // PR size tile. Answer for the store the surface actually read.
  if (
    readSource === ReadSource.Cloud &&
    decision.blocker === CloudReadCutoverBlocker.Offline
  ) {
    return OFFLINE_CLOUD_CACHE;
  }
  if (decision.failedOpen) {
    return `Uploading your history has not progressed for a while, so this workspace view may be missing ${countPhrase(decision.itemsRemaining)} still on this device.${deadLetterSuffix(decision)}`;
  }
  if (decision.blocker === null) {
    return undefined;
  }
  return DESCRIBE_BLOCKER[decision.blocker](decision);
}

/**
 * The reassurance this ticket exists to deliver, said in EVERY local-read state
 * rather than only the draining one. All of these read off a complete local
 * database — offline, mid-import, before a lane starts, or while the upload
 * drains — so the local view is whole in every one of them and the user is
 * owed that sentence each time.
 *
 * Deliberately NOT used for the two states where it would be a lie: the
 * dead-letter case (work that will never arrive) and the failed-open cloud read
 * (a view we already know may be short). Those get a next step instead.
 */
const NOTHING_IS_MISSING = "Nothing is missing.";

/**
 * The next step owed to anyone told that some of their work will not arrive.
 * Points at Diagnostics itself rather than its Withheld tab, which is
 * flag-gated (see `diagnostics-view.tsx`) and so may not be there to land on.
 */
const REVIEW_IN_DIAGNOSTICS = "Open Diagnostics to review.";

/**
 * ISS-5768: routed through the shared `formatCount` helper so this badge and the
 * Settings → History Sync cell quote the SAME machine identically. They already
 * agreed on the noun; they disagreed on the separator, so one screen showed
 * "2985 items" beside "2,985 items" for one number. Same class of drift the
 * ticket exists to remove, one layer down.
 */
function countPhrase(itemsRemaining: number | null): string {
  if (itemsRemaining === null) {
    return "some items";
  }
  return formatCount(itemsRemaining, "item");
}

function deadLetterSuffix(decision: CloudReadCutoverDecision): string {
  if (decision.deadLetteredCount <= 0) {
    return "";
  }
  return ` ${describeUndeliverableItems(decision.deadLetteredCount)} ${REVIEW_IN_DIAGNOSTICS}`;
}

/**
 * One sentence per blocker, for a reader who is NOT on the cloud — except the
 * hysteresis case, where the reader already cut over and later local work is
 * still catching up. Both cases are keyed off the same blocker, so the copy
 * distinguishes them by whether the decision put the reader on the cloud.
 */
const DESCRIBE_BLOCKER: Record<
  CloudReadCutoverBlocker,
  (decision: CloudReadCutoverDecision) => string | undefined
> = {
  // Signed out. The badge already says "Local", and there is nothing pending to
  // explain, so adding a sentence would be noise.
  [CloudReadCutoverBlocker.NotAuthenticated]: () => undefined,
  [CloudReadCutoverBlocker.Offline]: () =>
    `You are offline, so this is your own machine's data. ${NOTHING_IS_MISSING}`,
  [CloudReadCutoverBlocker.ReadinessUnknown]: () =>
    `Checking whether your workspace has a copy of your history. ${NOTHING_IS_MISSING}`,
  [CloudReadCutoverBlocker.ImportPending]: () =>
    `Still reading this device's history. We'll switch to your workspace once that finishes and the upload catches up. ${NOTHING_IS_MISSING}`,
  [CloudReadCutoverBlocker.SyncDraining]: (decision) =>
    describeCatchingUp(
      decision,
      `Your history is still uploading (${countPhrase(decision.itemsRemaining)} to go). ${NOTHING_IS_MISSING}`
    ),
  [CloudReadCutoverBlocker.SyncGaveUp]: (decision) =>
    describeCatchingUp(
      decision,
      `Uploading finished except for ${countPhrase(decision.deadLetteredCount)} that could not be sent. ${REVIEW_IN_DIAGNOSTICS}`
    ),
  [CloudReadCutoverBlocker.SyncNotEstablished]: (decision) =>
    describeCatchingUp(
      decision,
      `Part of your history has not started uploading yet. ${NOTHING_IS_MISSING}`
    ),
};

/**
 * The hysteresis wording. Once the reader has legitimately reached the cloud it
 * stays there (see `CloudReadCutoverLatch`), so a blocker seen from the cloud
 * means newer local work is catching up — a staleness, not a disappearance, and
 * it must not be worded like the pre-cutover wait.
 */
function describeCatchingUp(
  decision: CloudReadCutoverDecision,
  localWording: string
): string {
  if (decision.mode === DesktopAppCoreMode.Cloud) {
    return `Newer activity on this device is still uploading (${countPhrase(decision.itemsRemaining)}), so it may not appear here yet.`;
  }
  return localWording;
}

/**
 * ISS-5714: said to a reader whose surface is still serving cloud rows from
 * cache while the machine is offline. It must not borrow the local read's
 * "Nothing is missing." — the cache is a snapshot of the workspace taken before
 * the network went away, and anything added since is genuinely not in it.
 */
const OFFLINE_CLOUD_CACHE =
  "You are offline, so this is the last copy of your workspace this device downloaded. Newer activity may be missing.";

/**
 * ISS-5714: said to a reader whose surface produced a `Fallback` read — neither
 * this device nor the workspace answered, so what is on screen is a best-effort
 * result of unknown completeness.
 *
 * It states the outcome and stops. It does NOT borrow `NOTHING_IS_MISSING`
 * (nothing established that), and it does not name a blocker: the blocker
 * describes why the CUTOVER is held, which is a different question from why
 * this read produced no source at all, and answering the wrong one here is how
 * the tooltip ended up contradicting the badge above it.
 */
const FALLBACK_SOURCE_UNRESOLVED =
  "Neither this device nor your workspace answered, so this view is a best-effort result and may be incomplete.";
