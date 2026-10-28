import { readableOnboardingStateSchema } from "@repo/api/src/types/onboarding-persistence";
import { z } from "zod";
import {
  desktopGuestGuidedOnboardingStorageKey,
  readRawFlag,
  removeRawFlag,
  writeRawFlag,
} from "../dashboard/dashboard-storage-keys";

/**
 * ISS-10195 follow-up — what this install's persisted record says about a
 * SIGNED-OUT guest's guided onboarding run.
 *
 * ABSENCE IS NOT COMPLETION, the same fold `guest-tour-record.ts` states for
 * the tour. A fresh install, a cleared store, and a record some other build
 * left unreadable all mean NO RUN YET, and the answer they must not be folded
 * into is "this guest already finished onboarding" — that would hide the modal
 * from precisely the reader ISS-10195 set out to reach. Folding this way costs
 * a guest who really did finish one extra run; folding the other way costs the
 * feature entirely.
 *
 * `localStorage` hands back whatever is on disk, so this is a trust boundary
 * and gets a schema rather than a cast. The state is parsed with the READ-side
 * {@link readableOnboardingStateSchema} — unknown keys stripped, not refused —
 * because a record written by a NEWER desktop build must not take the guided
 * surface dark on an older one. `restoreOnboardingState` parses it strictly
 * again downstream, which is what makes stripping safe here.
 */
const guestGuidedOnboardingRecordSchema = z
  .object({
    /**
     * The local compare-and-swap counter. It plays the `OnboardingAttempt.revision`
     * role: the host keys `recoveredRevision` off it, so a Back out of the run
     * must not re-open the same revision.
     */
    revision: z.number().int().nonnegative(),
    state: readableOnboardingStateSchema,
  })
  .strict();

export type GuestGuidedOnboardingRecord = z.infer<
  typeof guestGuidedOnboardingRecordSchema
>;

/**
 * This install's guest run, or `null` when there is no trustworthy record.
 *
 * READ-ONLY, deliberately: a value that fails the schema is left exactly as it
 * was found rather than normalised, because rewriting an unreadable record here
 * would turn it into a confident one. The only thing that writes this key is a
 * transition the machine actually accepted.
 */
export function readGuestGuidedOnboardingRecord(): GuestGuidedOnboardingRecord | null {
  const raw = readRawFlag(desktopGuestGuidedOnboardingStorageKey);
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseRecordJson(raw);
  if (parsed === null) {
    return null;
  }
  const result = guestGuidedOnboardingRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Persist an accepted guest transition. */
export function writeGuestGuidedOnboardingRecord(
  record: GuestGuidedOnboardingRecord
): void {
  writeRawFlag(desktopGuestGuidedOnboardingStorageKey, JSON.stringify(record));
}

/**
 * Drop this install's guest run, because a SERVER run now owns the position it
 * described (ISS-10195 follow-up).
 *
 * The one legitimate reason to erase it. A guest's record is the local
 * authority only for a reader with no account; once the run has been handed to
 * an `OnboardingAttempt` row, keeping a second copy is how the two sources
 * drift — a later sign-out would resume a position the account has already
 * moved past. It is REMOVED rather than marked, so the absence fold at the top
 * of this file keeps meaning exactly one thing.
 *
 * Deliberately not called when a handoff is LOST: the record is the only
 * DURABLE description of where that guest was — the lost-write path holds the
 * position as the handoff hook's own run for the rest of that mount
 * (ISS-10340), but only this survives a relaunch and lets the handoff be
 * re-attempted — and dropping it would turn a recoverable lost write into the
 * discarded progress this whole path exists to prevent. A DETERMINATE answer is
 * the opposite case and does call this: the server has ruled on the command, so
 * the record describes a guest the account has moved past.
 */
export function clearGuestGuidedOnboardingRecord(): void {
  removeRawFlag(desktopGuestGuidedOnboardingStorageKey);
}

/**
 * `JSON.parse` on a store this code did not necessarily write. A malformed
 * string is the same answer as an absent one — see the fold above.
 */
function parseRecordJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
