import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
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
   * dispositions — `stale` / `syncing` / `failedTransient` / `failedPermanent` —
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
  session: Pick<AgentSessionDetail, "transcriptDisposition" | "lastSyncedAt">,
  options: { now?: Date | number } = {}
): SessionSyncStatus {
  const dispositionLabel = session.transcriptDisposition
    ? getTranscriptDispositionLabel(session.transcriptDisposition)
    : null;
  const tone = session.transcriptDisposition
    ? getTranscriptDispositionTone(session.transcriptDisposition)
    : null;
  const attention = session.transcriptDisposition
    ? isAttentionDisposition(session.transcriptDisposition)
    : false;

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
