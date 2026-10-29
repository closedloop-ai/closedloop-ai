import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import {
  CloudOffIcon,
  CloudUploadIcon,
  type LucideIcon,
  PauseCircleIcon,
} from "lucide-react";

/**
 * @file session-transcript-status-copy.ts
 * @description The WORDS and icons the session transcript panel gives an
 * absent, oversized, or terminally-skipped transcript — extracted from
 * `session-transcript-panel.tsx` (ISS-7516) when adding this ticket's fifth
 * absence state would have pushed that file past the 1,000-line ceiling.
 *
 * The seam is a real responsibility boundary, not a line-count slice: nothing
 * here renders. Every export is a pure string/icon decision over a transcript's
 * settled state, which is exactly the half of that panel a copy change touches
 * and the half that has no React in it. The panel keeps the JSX and the
 * precedence between states.
 */

/**
 * The literal harness value `apps/api` writes when a sync payload omits one
 * (`agent-sessions/service.ts` — `normalizeNullableString(session.harness) ??
 * "unknown"`). It reaches the client as a real string rather than a null, so it
 * is a sentinel to guard, not a product name to print.
 */
export const UNKNOWN_HARNESS = "unknown";

/**
 * ISS-7516 — the TITLE for a transcript that is NEVER EXPECTED, because the
 * machine that produced the session is on a data-sync level that keeps
 * transcripts local.
 *
 * PROPOSED WORDING, NOT A DECISION. Copy is the operator's call; this is one
 * exported constant (and its sibling below) precisely so changing it is a
 * one-line edit that needs no knowledge of the panel's state machine.
 *
 * It must not read as the pending state's "Transcript still syncing", and it
 * must not read as the terminal "Transcript not archived"
 * either: a `metadata`-level machine's transcript was not archived AND never
 * will be, but nothing failed and nothing is on a retry ladder. The difference
 * is carried in TEXT, never in colour alone (WCAG 1.4.1) — the icon is shared
 * with the other settled state on purpose, because an icon is not a statement.
 */
export const TRANSCRIPT_NEVER_EXPECTED_TITLE =
  "Transcript stays on this machine";

/**
 * ISS-7516 — the DESCRIPTION for that state. PROPOSED WORDING, NOT A DECISION
 * (see {@link TRANSCRIPT_NEVER_EXPECTED_TITLE}).
 *
 * Two jobs, and the DESCRIPTION does neither of them twice. The title already
 * states the fact, so this states only the CAUSE — named against the state it
 * is most often mistaken for — and the REMEDY. An earlier draft opened by
 * restating the title in other words and ran to six centred lines against
 * two-line siblings (Pascoe); the panel's other four states each say their
 * thing once, and so does this one.
 *
 * A third sentence, that the page's figures are real because the metadata lane
 * wrote them, was cut deliberately. It is a true and useful thing to say and it
 * is not this panel's to say — the transcript pane defending the metrics is an
 * answer to a question the reader did not ask here, and ISS-7427 already owns
 * that disclosure on the Session Trace header, where the count it qualifies
 * actually lives.
 *
 * It names the SETTING rather than the level the reader is CURRENTLY on: both
 * `metadata` and `local` exclude transcripts (`syncTierAllowsTranscripts`
 * admits only `full`), so asserting which one they picked would be a guess this
 * panel has no evidence for. The level to switch TO is not a guess — only
 * `full` carries transcripts — so it is named, using the picker's own words
 * ("Full transcripts", `data-sync-copy.ts`) and the Settings tab's own spelling
 * ("Data & Sync"), so the sentence points at a control the reader can find.
 *
 * WHOSE machine is the SOURCE machine, never the reader's (review, #5737). An
 * earlier draft opened "Your data sync level" and sent the reader to their own
 * Settings, but `dataSyncLevel` describes the machine that RECORDED the session
 * — so that sentence was wrong for every web reader, who has no such setting,
 * and for any desktop reader opening a COLLEAGUE's session, whose own level is
 * irrelevant to a transcript sitting on someone else's disk. "The source
 * machine" is the sibling `missing` state's own noun ("once the source machine
 * uploads it"), reused rather than reinvented so the panel names the recording
 * device one way. The remedy stays a real remedy for the person who can act on
 * it, and stops reading as an instruction the reader cannot carry out.
 *
 * The absence is stated as CONDITIONAL on the level, not as absolute, and the
 * remedy names this session rather than only future ones. Both are load-bearing
 * (review): changing the level calls `kickTranscriptSweepAfterTierChange`, whose
 * sweep runs `discoverTranscriptFiles` over the machine's WHOLE transcript
 * history with no recency bound, so the file behind the session on screen is
 * re-discovered and uploaded — provided it is still on disk, which is why the
 * sentence says "the transcripts it still has" rather than promising this one
 * unconditionally. Saying "never" and "from future sessions" would
 * steer a reader who wants this transcript away from the one control that
 * produces it — the same false permanence this state exists to remove from the
 * not-yet-arrived copy, moved one state over.
 *
 * The sync-level clause must stay FIRST. The terminal `permanentUnavailable`
 * copy already ends with "It remains on the machine where the session ran", so
 * that clause is the only thing separating the two SETTLED states in prose; if
 * it ever slides to the end of the sentence the two read alike.
 */
export const TRANSCRIPT_NEVER_EXPECTED_DESCRIPTION =
  "The source machine's data sync level, not a stalled upload, is why. Switch that machine to Full transcripts in Settings > Data & Sync to upload the transcripts it still has, including this one.";

/**
 * Human copy for a permanently-unavailable (skipped) transcript, keyed by the
 * terminal reason (FEA-3476). For the size-cap reason the copy states the
 * situation AND the way out — "sync it from the machine where the session ran" —
 * because the force-archive override (FEA-3489) IS offered below it: the desktop
 * shows the button that does exactly that, and the web (where the button is not
 * rendered) reads the same line as the reason it can't act here. The other
 * reasons have no override: the two HARD ones read as a plain dead end, and the
 * two recoverable ones (`materialized_source_unavailable`,
 * `environment_unavailable`) say what has to come back instead — a dead-end
 * sentence under a non-permanent verdict is the lie these reasons exist to end.
 */
const PERMANENT_UNAVAILABLE_DESCRIPTIONS: Record<TranscriptSkipReason, string> =
  {
    [TranscriptSkipReason.TooLarge]:
      "This transcript is over the automatic archive size limit. Sync it from the machine where the session ran to view it here.",
    [TranscriptSkipReason.SourceGone]:
      "This session’s local transcript was removed before it could be archived, so it can’t be shown here.",
    // ISS-4621: the desktop stopped retrying after repeated upload failures.
    // "May still be" — not "remains" — because this reason is written from the
    // transport-failure ladder, which never stats the source (the path that
    // does emits source_gone instead), so local presence is unverified.
    [TranscriptSkipReason.RetriesExhausted]:
      "This transcript couldn’t be uploaded after repeated attempts, so it can’t be shown here. It may still be on the machine where the session ran.",
    // ISS-4695 item 3: a batch-materialized (OpenCode) source that wasn't ready
    // this sweep is REGENERABLE — the copy points at recovery rather than reading
    // as a dead end, matching the recoverable cloud disposition (`syncing`, not
    // `failedPermanent`). Trimmed to the sibling shape (the "regenerated
    // automatically" internal mechanic is not user-actionable).
    [TranscriptSkipReason.MaterializedSourceUnavailable]:
      "This transcript’s source wasn’t ready when it was last archived. It should appear here after the next sync from the machine where the session ran.",
    // ISS-9884: the machine gave up on an ENVIRONMENTAL wall clock, not on
    // anything about this file. The copy names the cause and the fact that
    // recovery needs no user action — saying "couldn't be uploaded" here would
    // repeat the retries_exhausted lie this reason exists to end.
    [TranscriptSkipReason.EnvironmentUnavailable]:
      "The machine stopped trying because this workspace’s transcript archive isn’t available. It resumes automatically once that’s restored.",
  };

const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  opencode: "OpenCode",
};

export function permanentUnavailableDescription(
  reason: TranscriptSkipReason | null
): string {
  if (reason === null) {
    return "This transcript was not archived and can’t be shown here. It remains on the machine where the session ran.";
  }
  // Exhaustive Record: a new skip reason fails typecheck here until someone
  // writes copy for it, instead of silently inheriting the generic sentence.
  return PERMANENT_UNAVAILABLE_DESCRIPTIONS[reason];
}

/**
 * Title + icon for a `permanentlyUnavailable` file. ISS-4695 item 3 review
 * (whitlockk / logical-QA): a RECOVERABLE reason must NOT read as a dead end.
 * `materialized_source_unavailable` maps to the recoverable `syncing` cloud
 * disposition (`deriveTranscriptDisposition`), so its headline is "Transcript
 * still syncing" with `CloudUploadIcon`, the same honest presentation the
 * `uploadPending` / `missing` states use — instead of the hard "Transcript not
 * archived" / `CloudOffIcon` reserved for reasons that are genuinely never
 * coming, plus an unknown/`null` legacy reason.
 *
 * ISS-9884: keyed on the REASON rather than on the recoverable boolean, for the
 * same arithmetic that moved the cloud disposition off it — there are now three
 * headlines and a two-valued predicate can only pick two. `environment_unavailable`
 * is recoverable AND not being attempted, so neither existing headline is true of
 * it: "still syncing" claims an upload in flight, "not archived" claims a dead
 * end. The exhaustive `Record` is also the stronger guard the boolean was not — a
 * new reason now fails `tsc` here instead of inheriting a headline.
 */
const TERMINAL_UNAVAILABLE_TITLES: Record<TranscriptSkipReason, string> = {
  [TranscriptSkipReason.TooLarge]: "Transcript not archived",
  [TranscriptSkipReason.SourceGone]: "Transcript not archived",
  [TranscriptSkipReason.RetriesExhausted]: "Transcript not archived",
  [TranscriptSkipReason.MaterializedSourceUnavailable]:
    "Transcript still syncing",
  [TranscriptSkipReason.EnvironmentUnavailable]: "Transcript upload paused",
};

const TERMINAL_UNAVAILABLE_ICONS: Record<TranscriptSkipReason, LucideIcon> = {
  [TranscriptSkipReason.TooLarge]: CloudOffIcon,
  [TranscriptSkipReason.SourceGone]: CloudOffIcon,
  [TranscriptSkipReason.RetriesExhausted]: CloudOffIcon,
  [TranscriptSkipReason.MaterializedSourceUnavailable]: CloudUploadIcon,
  // Not `CloudUploadIcon`: nothing is uploading. Not `CloudOffIcon`: this is
  // not a dead end. Paused is its own thing and reads as resumable.
  [TranscriptSkipReason.EnvironmentUnavailable]: PauseCircleIcon,
};

export function terminalUnavailablePresentation(
  reason: TranscriptSkipReason | null
): {
  title: string;
  icon: LucideIcon;
  iconClassName: string;
} {
  // `null` is the unknown/legacy label the reader degraded, not an enum member:
  // conservatively the hard headline, matching the cloud's `failedPermanent`.
  if (reason === null) {
    return {
      title: "Transcript not archived",
      icon: CloudOffIcon,
      iconClassName: "text-muted-foreground",
    };
  }
  return {
    title: TERMINAL_UNAVAILABLE_TITLES[reason],
    icon: TERMINAL_UNAVAILABLE_ICONS[reason],
    iconClassName: "text-muted-foreground",
  };
}

export function transcriptNounForHarness(harness: string): string {
  const trimmed = harness.trim();
  if (!trimmed || trimmed.toLowerCase() === UNKNOWN_HARNESS) {
    return "transcript";
  }
  const label =
    HARNESS_DISPLAY_NAMES[trimmed.toLowerCase()] ??
    trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return `${label} transcript`;
}
