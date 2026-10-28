import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  AgentSessionCloudSyncState,
  type DeadLetteredCloudSyncState,
} from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import {
  ensureDate,
  formatRelativeTime,
} from "@repo/app/shared/lib/date-utils";
import type { Tone } from "@repo/design-system/components/ui/types";

/**
 * FEA-3529: presentational projection of the per-session transcript sync state
 * that FEA-3479 (PRD-536 G1) added to the data contract but no Sessions-UI
 * element consumed. Folds the session-level `transcriptDisposition` verdict and
 * the `lastSyncedAt` freshness timestamp into human-facing labels a lag-aware
 * detail surface can render. Pure + surface-agnostic so both the web shell and
 * the desktop renderer share one derivation and it stays unit-testable.
 */
export type SessionSyncStatus = {
  /** Human disposition verdict, or null when the session carries none. */
  dispositionLabel: string | null;
  /** "Last synced <relative>" freshness, or null when there is no timestamp. */
  freshnessLabel: string | null;
  /**
   * The two parts joined for a single Properties-row value, or null when
   * neither is present — the caller renders nothing in that case so the row is
   * purely additive and a version-skewed producer that omits both degrades
   * without an empty affordance.
   */
  valueLabel: string | null;
  /**
   * The design-system tone for the disposition verdict, or null when there is no
   * (recognized) disposition — e.g. a row whose producer serves `lastSyncedAt`
   * but no `transcriptDisposition`, so the affordance is a neutral freshness
   * marker rather than a colored verdict. ISS-4647: the desktop local list DOES
   * serve a disposition now (for a session with a local transcript row whose
   * metadata lane is caught up); a local row without one still lands here.
   */
  tone: SessionSyncTone | null;
  /**
   * Whether the verdict warrants an attention-drawing (colored badge) treatment
   * vs. a quiet, muted metadata treatment. True only for the non-nominal
   * dispositions — `stale` / `syncing` / `failedTransient` / `failedPermanent`,
   * and the ISS-9884 paused pair, which is a `failedTransient` —
   * where the reader should notice the transcript is not currently in sync. A
   * `synced` / `neverExpected` verdict, or a freshness-only (disposition-absent)
   * row, is nominal (false): the list renders it as quiet muted text so a healthy
   * fleet is not a wall of colored badges (the AI-slop "badge on every row" tell),
   * matching the detail Properties panel's quiet Sync row.
   */
  attention: boolean;
};

/**
 * Human label for each transcript disposition. A `Record` keyed by the const
 * object gives compile-time exhaustiveness: a new `TranscriptDisposition`
 * variant fails typecheck here until it is given a label.
 */
const TRANSCRIPT_DISPOSITION_LABELS: Record<TranscriptDisposition, string> = {
  [TranscriptDisposition.Synced]: "Synced",
  [TranscriptDisposition.Stale]: "Stale",
  [TranscriptDisposition.Syncing]: "Syncing",
  // ISS-9884: true of the RE-QUEUED producer only. A `failedTransient` whose
  // reason is `environment_unavailable` is NOT retrying — the lane stopped —
  // and takes {@link TRANSCRIPT_UPLOAD_PAUSED_PRESENTATION} instead. This map
  // is keyed by disposition and structurally cannot tell them apart, which is
  // why the paused pair is resolved before the lookup rather than inside it.
  [TranscriptDisposition.FailedTransient]: "Sync failed, retrying",
  [TranscriptDisposition.FailedPermanent]: "Sync failed",
  [TranscriptDisposition.NeverExpected]: "No transcript",
};

/**
 * Alias of the canonical design-system {@link Tone} union (SSOT) — the tone this
 * derivation emits is fed straight into `ToneBadge`'s `tone` prop, so it must be
 * exactly that type rather than a separately hand-maintained subset that could
 * drift from the design system. Kept as a named alias so existing importers keep
 * a semantic name at their call sites.
 */
export type SessionSyncTone = Tone;

/**
 * The design-system {@link SessionSyncTone} for each disposition. A synced
 * transcript reads as a quiet "success" marker (uploaded and current); a stale
 * one warns; a syncing one is informational; either failure is a danger signal.
 * `neverExpected` reads as muted (absence is normal, not an error).
 * Surface-agnostic so the list-row badge and any future affordance tone the
 * verdict identically. `Record`-keyed for the same compile-time exhaustiveness
 * as the labels above.
 */
const TRANSCRIPT_DISPOSITION_TONES: Record<
  TranscriptDisposition,
  SessionSyncTone
> = {
  [TranscriptDisposition.Synced]: "success",
  [TranscriptDisposition.Stale]: "warning",
  [TranscriptDisposition.Syncing]: "info",
  [TranscriptDisposition.FailedTransient]: "danger",
  [TranscriptDisposition.FailedPermanent]: "danger",
  [TranscriptDisposition.NeverExpected]: "muted",
};

/**
 * The {@link SessionSyncTone} for a disposition, or `null` for an
 * unrecognized/absent value (a version-skewed producer can send a newer string
 * not in the `Record`). Callers fall back to a neutral tone when null, mirroring
 * how {@link getTranscriptDispositionLabel} normalizes an unknown label.
 */
export function getTranscriptDispositionTone(
  disposition: TranscriptDisposition
): SessionSyncTone | null {
  return TRANSCRIPT_DISPOSITION_TONES[disposition] ?? null;
}

/**
 * Whether a disposition is non-nominal — the transcript is not currently in
 * sync, so the reader should notice. `synced`/`neverExpected` are the steady
 * states (nominal, false); `stale`/`syncing`/`failed*` warrant attention (true).
 * `Record`-keyed for compile-time exhaustiveness: a new disposition variant must
 * declare whether it draws attention. An unrecognized (version-skewed) value
 * falls through to `false` — a client that does not know the verdict does not
 * shout about it.
 */
const TRANSCRIPT_DISPOSITION_ATTENTION: Record<TranscriptDisposition, boolean> =
  {
    [TranscriptDisposition.Synced]: false,
    [TranscriptDisposition.Stale]: true,
    [TranscriptDisposition.Syncing]: true,
    [TranscriptDisposition.FailedTransient]: true,
    [TranscriptDisposition.FailedPermanent]: true,
    [TranscriptDisposition.NeverExpected]: false,
  };

export function isAttentionDisposition(
  disposition: TranscriptDisposition
): boolean {
  return TRANSCRIPT_DISPOSITION_ATTENTION[disposition] ?? false;
}

/**
 * Human label for a transcript disposition, or `null` for an unrecognized
 * value. `transcriptDisposition` is an optional cross-version contract field, so
 * a version-skewed producer can send a newer/unknown string that is not in the
 * `Record`; the lookup would then be `undefined` at runtime despite the
 * `TranscriptDisposition` type. Normalizing that to `null` keeps the row
 * degrading cleanly (no `undefined · Last synced …`) instead of trusting the
 * declared type over the runtime shape.
 */
export function getTranscriptDispositionLabel(
  disposition: TranscriptDisposition
): string | null {
  return TRANSCRIPT_DISPOSITION_LABELS[disposition] ?? null;
}

/**
 * Derives the {@link SessionSyncStatus} labels from a session's optional
 * `transcriptDisposition` + `lastSyncedAt`. An absent or invalid timestamp
 * yields a null `freshnessLabel` (never a thrown or "Invalid Date" render).
 * `options.now` is injectable so the relative label is deterministic in tests.
 */
export function getSessionSyncStatus(
  session: Pick<
    AgentSessionDetail,
    "transcriptDisposition" | "transcriptDispositionReason" | "lastSyncedAt"
  > &
    Partial<Pick<AgentSessionDetail, "cloudSyncState">>,
  options: { now?: Date | number } = {}
): SessionSyncStatus {
  const { dispositionLabel, tone, attention } =
    resolveDeadLetterPresentation(session.cloudSyncState) ??
    resolveDispositionPresentation(
      session.transcriptDisposition,
      session.transcriptDispositionReason
    );

  const syncedAt = ensureDate(session.lastSyncedAt);
  const freshnessLabel =
    syncedAt && Number.isFinite(syncedAt.getTime())
      ? `Last synced ${formatRelativeTime(syncedAt, { now: options.now })}`
      : null;

  const parts = [dispositionLabel, freshnessLabel].filter(
    (part): part is string => part !== null
  );
  const valueLabel = parts.length > 0 ? parts.join(" · ") : null;

  return { dispositionLabel, freshnessLabel, valueLabel, tone, attention };
}

/**
 * ISS-9884: the one place that decides a transcript's upload is PAUSED rather
 * than retrying — the desktop's lane hit its 24h environmental wall clock and
 * STOPPED attempting, on a file nothing was ever established to be wrong with.
 *
 * Both halves are load-bearing and neither is sufficient alone. The disposition
 * is `failedTransient` for the ordinary re-queued-with-backoff failure too, and
 * a reason can ride a row whose verdict it did not produce on a version-skewed
 * producer; only the PAIR names this state.
 *
 * Exported because `CloudSyncStateBadge` renders the same fact one layer out.
 * It reads this predicate rather than re-deriving the pair, so the list chip
 * and the list label cannot come to disagree about which rows are paused —
 * which is exactly how the pre-ISS-9884 surfaces drifted from the detail panel.
 */
export function isTranscriptUploadPaused(
  disposition: TranscriptDisposition | undefined,
  reason: TranscriptSkipReason | undefined
): boolean {
  return (
    disposition === TranscriptDisposition.FailedTransient &&
    reason === TranscriptSkipReason.EnvironmentUnavailable
  );
}

/**
 * ISS-9884: how a paused transcript reads on a list row.
 *
 * `warning`, not `danger`: nothing failed. The transport was unavailable and
 * the lane stopped asking, which is a state to notice rather than a dead end —
 * and `danger` here would be the same lie in a different colour, since
 * `failedPermanent` (the transcript is genuinely never coming) is what `danger`
 * already means on this surface. `attention` stays true so the row still
 * surfaces on a dense list; a paused upload is precisely the exception a
 * scanner is looking for.
 */
const TRANSCRIPT_UPLOAD_PAUSED_PRESENTATION: DispositionPresentation = {
  dispositionLabel: "Upload paused",
  tone: "warning",
  attention: true,
};

/** The disposition-derived third of a {@link SessionSyncStatus}. */
type DispositionPresentation = Pick<
  SessionSyncStatus,
  "dispositionLabel" | "tone" | "attention"
>;

/**
 * ISS-9884: resolve the label/tone/attention triple from the verdict PAIR.
 *
 * Before this the three were three independent `Record` lookups on the
 * disposition alone, which is why an environmentally-abandoned transcript read
 * "Sync failed, retrying" in danger red on the list while the detail panel
 * said "Transcript upload paused". The paused pair is resolved FIRST and as a
 * whole presentation, so the three parts cannot be branched separately and end
 * up half-converted.
 */
function resolveDispositionPresentation(
  disposition: TranscriptDisposition | undefined,
  reason: TranscriptSkipReason | undefined
): DispositionPresentation {
  if (disposition === undefined) {
    return { dispositionLabel: null, tone: null, attention: false };
  }
  if (isTranscriptUploadPaused(disposition, reason)) {
    return TRANSCRIPT_UPLOAD_PAUSED_PRESENTATION;
  }
  return {
    dispositionLabel: getTranscriptDispositionLabel(disposition),
    tone: getTranscriptDispositionTone(disposition),
    attention: isAttentionDisposition(disposition),
  };
}

/**
 * ISS-11427: how a session the desktop sync lane dead-lettered reads, keyed by
 * the state its row carries. Labels per the operator ruling (Marisol Ashgrove,
 * 2026-10-05): "fine to have dead letter and abandoned". No tooltip was
 * supplied, so none is rendered.
 *
 * Tones follow the transcript verdicts' meanings on this surface: a dead
 * letter will be retried, so it warns, as a paused upload does; an abandoned
 * row is never coming, which is what `danger` means for `failedPermanent`.
 */
const DEAD_LETTERED_PRESENTATION: Record<
  DeadLetteredCloudSyncState,
  DispositionPresentation
> = {
  [AgentSessionCloudSyncState.DeadLetter]: {
    dispositionLabel: "Dead letter",
    tone: "warning",
    attention: true,
  },
  [AgentSessionCloudSyncState.Abandoned]: {
    dispositionLabel: "Abandoned",
    tone: "danger",
    attention: true,
  },
};

/** The dead-letter presentation for a row's sync state, or null when it has none. */
function resolveDeadLetterPresentation(
  cloudSyncState: AgentSessionCloudSyncState | undefined
): DispositionPresentation | null {
  if (
    cloudSyncState === AgentSessionCloudSyncState.DeadLetter ||
    cloudSyncState === AgentSessionCloudSyncState.Abandoned
  ) {
    return DEAD_LETTERED_PRESENTATION[cloudSyncState];
  }
  return null;
}
