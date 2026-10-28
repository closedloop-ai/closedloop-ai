import type { TranscriptAvailabilitySummary } from "@repo/api/src/types/desktop-transcripts";
import type { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  isTranscriptReadable,
  MAIN_FILE_KEY,
} from "../transcript-availability";
import type { SessionEvidenceInput } from "./session-evidence-coverage";

/**
 * ISS-7427: assemble the evidence a session-detail response actually carries,
 * for {@link resolveSessionEvidenceCoverage} to fold.
 *
 * Split out of `findSessionDetail` so the read path states WHICH values are
 * evidence in one place rather than inline among the response projection, and
 * so growing the evidence set does not grow `service.ts`. Pure and derived
 * entirely from values the detail read already holds — no extra DB read.
 */

/**
 * The rollup columns the detail response serves, structurally typed so the
 * session list item satisfies it without this module importing the whole wire
 * contract. Every one is metadata-lane: written by `agent-sessions` sync,
 * independent of the transcript blob lane.
 */
export type SessionEvidenceRollupFields = {
  /**
   * The session span's start. `SessionDetail.sessionStartedAt` is a non-null
   * column, so in practice this is always set on a served read — see
   * {@link SessionEvidenceInput.hasSessionSpan} for why it counts as evidence
   * regardless.
   */
  startedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type SessionEvidenceInputSource = {
  transcriptDisposition: TranscriptDisposition;
  /**
   * `turnItems.length`, NOT `events.length`: the trace count the reader sees is
   * the projection (`getTraceCountLabel`), which drops Stop markers, coalesces
   * tool runs, and adds metadata messages plus subagents. Recording the raw row
   * count would put a second irreconcilable number on the very screen this
   * instrument exists to reconcile.
   */
  turnItemCount: number;
  /** Whether the underlying event read hit its row ceiling. */
  eventsTruncated: boolean;
  /** Per-file transcript summaries, main included. */
  transcripts: TranscriptAvailabilitySummary[];
  rollup: SessionEvidenceRollupFields;
  /** The reconciled cost the response serves, in USD; `null` when unpriced. */
  estimatedCostUsd: number | null;
};

export function buildSessionEvidenceInput(
  source: SessionEvidenceInputSource
): SessionEvidenceInput {
  return {
    transcriptDisposition: source.transcriptDisposition,
    derivedEventCount: source.turnItemCount,
    derivedEventsTruncated: source.eventsTruncated,
    readableSubagentTranscriptCount: source.transcripts.filter(
      (summary) =>
        summary.fileKey !== MAIN_FILE_KEY &&
        isTranscriptReadable(summary.availability)
    ).length,
    hasMetricRollup:
      (source.estimatedCostUsd !== null && source.estimatedCostUsd > 0) ||
      source.rollup.inputTokens > 0 ||
      source.rollup.outputTokens > 0 ||
      source.rollup.cacheReadTokens > 0 ||
      source.rollup.cacheWriteTokens > 0,
    // The `startedAt` half of the `startedAt`/`endedAt` pair the Duration row
    // renders from. `endedAt` is deliberately NOT required: an unterminated
    // session renders a live `now - startedAt` elapsed just the same, so
    // demanding both would re-introduce the undercount on active sessions.
    hasSessionSpan: source.rollup.startedAt !== null,
  };
}
