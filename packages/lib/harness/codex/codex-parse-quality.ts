/**
 * @file codex-parse-quality.ts
 * @description ISS-7625: the one `parseQuality` shape a Codex rollout reports.
 *
 * Extracted from `parse-codex.ts` rather than added to it, under the root
 * AGENTS.md line-count contract: this is a cohesive unit — the whole question
 * of how a rollout's line counts become a `NormalizedParseQuality`, with none
 * of the parsing.
 */
import type { NormalizedParseQuality } from "../parse-quality";

/** The accumulator counters that ride along on a rollout's parse quality. */
export type CodexParseQualityAccumulator = {
  malformedRateLimits: number;
  orphanedToolOutputs: number;
  ambiguousToolOutputs: number;
};

/** The line-scan counters a rollout parse tracks as it streams. */
export type CodexParseQualityScan = {
  totalLines: number;
  malformedLines: number;
  lastLineMalformed: boolean;
  unknownRecords: number;
};

/**
 * Build the parse quality for one rollout, used by BOTH the session that carries
 * it and the ISS-7625 unreadable-parse sink.
 *
 * Shared rather than rebuilt at each site because the two must agree: the
 * ingest-failure classifier measures `malformedLines` against `totalLines` with
 * the trailing truncation discounted, so a null-path summary that omitted one of
 * the optional counters would classify differently from the identical session
 * that happened to carry a timestamp.
 *
 * Each optional counter is OMITTED when zero, so a clean rollout round-trips
 * byte-identically against its frozen normalized.json (no golden churn).
 */
export function buildCodexParseQuality(
  acc: CodexParseQualityAccumulator,
  scan: CodexParseQualityScan
): NormalizedParseQuality {
  return {
    totalLines: scan.totalLines,
    malformedLines: scan.malformedLines,
    truncatedFinalLine: scan.lastLineMalformed,
    ...(acc.malformedRateLimits > 0
      ? { malformedRateLimits: acc.malformedRateLimits }
      : {}),
    ...(scan.unknownRecords > 0 ? { unknownRecords: scan.unknownRecords } : {}),
    ...(acc.orphanedToolOutputs > 0
      ? { orphanedToolOutputs: acc.orphanedToolOutputs }
      : {}),
    ...(acc.ambiguousToolOutputs > 0
      ? { ambiguousToolOutputs: acc.ambiguousToolOutputs }
      : {}),
  };
}
