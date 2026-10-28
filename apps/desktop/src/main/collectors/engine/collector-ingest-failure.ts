/**
 * @file collector-ingest-failure.ts
 * @description ISS-6336 (PRD-650): how a collector ingest failure NAMES itself.
 * The pure mapping half of the counters — the accumulator and the tick stay in
 * `../../telemetry/import-health-telemetry.ts`.
 *
 * Signals the collectors already compute, and previously threw away: a source
 * whose historical parse threw or timed out, and the `parseQuality` counts the
 * parsers persist on every session. `src/main/collectors/**` emitted no
 * telemetry at all, so an install whose transcripts stopped parsing after a
 * harness update was indistinguishable from an install with no sessions. The
 * third signal, quarantine, is a LEVEL rather than an occurrence and so is read
 * as a gauge by the tracker instead of named here.
 *
 * It lives HERE, under the engine, rather than beside the tracker: the engine
 * must keep no static edge to the telemetry RUNTIME, and this module is not one
 * — it imports the contract's enum and this directory's own quarantine and
 * parse-quality vocabulary, and holds no emitter, no exporter, and no state. The
 * runtime is still reached only through the injected `onIngestFailure` sink.
 *
 * Counts and closed enums only (PRD-389 §8). Nothing here reads a source path, a
 * session id, a session name, or transcript content, and every output is an enum
 * member. {@link sessionIngestFailures} is handed a whole `NormalizedSession`
 * rather than a projection of one, so that restriction is a rule this module
 * keeps rather than a shape the signature enforces: it reads `parseQuality`'s
 * numbers and the boolean `payloadClamped`, and nothing else on the session may
 * be inspected here.
 */
import {
  ImportIngestFailure,
  ImportParseDegradedSite,
} from "@closedloop-ai/telemetry-contract/app";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import type { NormalizedSession } from "@repo/lib/harness/types";
import {
  corruptibleLineCount,
  corruptLineCount,
} from "./parse-quality-scan.js";

/**
 * Hand one reason to the engine's ingest-failure sink, per the desktop
 * exporter-boundary rule: a telemetry sink that throws must never reach the
 * import pipeline, so the collector pass proceeds whatever the sink does. An
 * omitted sink restores the pre-ISS-6336 silence with no branch at the call
 * site.
 *
 * The failure is swallowed without a diagnostic on purpose. Not every collector
 * seam holds a logger, and a guard that logs from one call site and not the
 * other buys an asymmetry — parse failures leaving a trail while quarantine
 * exclusions vanish — rather than any real coverage.
 */
export function reportIngestFailure(
  sink: ((reason: ImportIngestFailure) => void) | undefined,
  reason: ImportIngestFailure
): void {
  try {
    sink?.(reason);
  } catch {
    // Best-effort by contract; see above.
  }
}

/**
 * The ingest-failure reasons one session's already-computed `parseQuality`
 * warrants — none for a clean parse.
 *
 * A benign trailing truncation is discounted on BOTH sides of the
 * degraded/unreadable split, via the one canonical `corruptLineCount` /
 * `corruptibleLineCount` pair. Comparing a discounted numerator against an
 * undiscounted `totalLines` reported "some lines lost" for a three-line
 * transcript whose every line failed to parse. ISS-6336 (whitlockk review): the
 * denominator discounts each FOLDED CHILD's truncation too, which the fold
 * already took out of the numerator — a multi-file session where every line was
 * lost otherwise reported `degraded`, one discount short of the truth.
 *
 * `unreadable` is not a louder `degraded`: they are mutually exclusive, so a
 * session that lost everything is counted once, in the bucket that says so.
 * `unrouted` IS independent of both — those lines parsed as JSON and were
 * dropped by the classifier, not by `JSON.parse` — so a session can carry it
 * alongside either.
 */
export function parseQualityIngestFailures(
  quality: NormalizedParseQuality | undefined
): ImportIngestFailure[] {
  if (!quality) {
    return [];
  }
  const failures: ImportIngestFailure[] = [];
  const corrupt = corruptLineCount(quality);
  if (corrupt > 0) {
    failures.push(
      corrupt >= corruptibleLineCount(quality)
        ? ImportIngestFailure.SessionParseUnreadable
        : ImportIngestFailure.SessionParseDegraded
    );
  }
  if ((quality.unknownRecords ?? 0) > 0) {
    failures.push(ImportIngestFailure.SessionRecordsUnrouted);
  }
  return failures;
}

/**
 * Every ingest-failure reason ONE offered session warrants (ISS-5822).
 *
 * Two independent degradations, deliberately in one list. `parseQuality`
 * describes what the parser could decode from the transcript; `payloadClamped`
 * describes what the worker→main-process response budget then cut off a
 * cleanly-parsed session. A session can carry either, both, or neither, and the
 * caller counts each returned reason once per session per tally window.
 *
 * The clamp reason is derived from a flag the boundary already stamped rather
 * than re-measured here: the sizes it was decided against are gone by the time a
 * session reaches an importer, so anything computed at this layer would be a
 * guess dressed as a measurement.
 */
export function sessionIngestFailures(
  session: NormalizedSession
): ImportIngestFailure[] {
  const failures = parseQualityIngestFailures(session.parseQuality);
  if (session.payloadClamped === true) {
    failures.push(ImportIngestFailure.SessionPayloadClamped);
  }
  return failures;
}

/**
 * Report the ingest failure a source's NO-SESSION parse warrants (ISS-7625).
 *
 * ONLY `unreadable` is emitted here, and the restriction is the point. The
 * classifier is still {@link parseQualityIngestFailures}, so the corrupt-vs-total
 * split (and its trailing-truncation discount on both sides) is decided in one
 * place and cannot drift from the per-session path — but of the reasons it can
 * return, only `unreadable` describes a source that produced nothing.
 * `session_parse_degraded` and `session_records_unrouted` both assert that a
 * SESSION parsed and lost some content, which is false here and would leave a
 * monitor unable to tell "a session imported minus two lines" from "this source
 * imported nothing at all".
 *
 * So a partially-corrupt transcript that also has no timestamp reports nothing,
 * exactly as before this change: it is a real gap, but it is a gap in the
 * contract's vocabulary (there is no `source_parse_unreadable`) rather than one
 * this function should paper over by borrowing a reason that means something
 * else. A clean parse scores no corrupt lines and reports nothing either.
 */
export function reportUnreadableParseIngestFailures(
  sink: ((reason: ImportIngestFailure) => void) | undefined,
  quality: NormalizedParseQuality
): void {
  if (
    parseQualityIngestFailures(quality).includes(
      ImportIngestFailure.SessionParseUnreadable
    )
  ) {
    reportIngestFailure(sink, ImportIngestFailure.SessionParseUnreadable);
  }
}

/**
 * Build the sink a pass hands to `parseHistoricalSource` so a source that parsed
 * to NO session still reports what its transcript cost (ISS-7625).
 *
 * Generation-gated exactly as the `threw`/`timedOut` reports are, via the
 * injected `isImportActive`: a stop()/restart leaves the source unmarked, so it
 * is re-parsed next pass and one transcript would be counted twice. The parse
 * OUTCOME is unaffected either way; only the report is suppressed.
 */
export function createUnreadableParseReporter(
  sink: ((reason: ImportIngestFailure) => void) | undefined,
  isImportActive: () => boolean
): (quality: NormalizedParseQuality) => void {
  return (quality) => {
    if (isImportActive()) {
      reportUnreadableParseIngestFailures(sink, quality);
    }
  };
}

/**
 * ISS-12036: WHICH of the three folded files a session's corrupt lines came
 * from, or `undefined` when this session's parse quality cannot say.
 *
 * `malformedLines` sums the session's own transcript, every folded child (a
 * Claude subagent sidecar, a Codex workflow journal) and every folded descendant
 * rollout, so `session_parse_degraded` reported that content was lost and
 * nothing reported by whom. The fold sites tally their own contributions, and the
 * session's own share is the remainder — which is why this reads the two
 * attributed counters and subtracts, rather than adding a third counter that
 * could disagree with `malformedLines`.
 *
 * `undefined` on three distinct cases, and all three are honest absences rather
 * than a `main_transcript` default: no quality at all, nothing corrupt to
 * attribute, and a remainder that came out negative — which would mean an
 * attributed counter exceeded the total it is a share of, so the shares are not
 * trustworthy and naming one would be a guess. Only a positive own-share with no
 * folded share is `main_transcript`.
 */
export function parseDegradedSite(
  quality: NormalizedParseQuality | undefined
): ImportParseDegradedSite | undefined {
  if (!quality) {
    return undefined;
  }
  const corrupt = corruptLineCount(quality);
  if (corrupt <= 0) {
    return undefined;
  }
  const child = quality.foldedChildMalformedLines ?? 0;
  const descendant = quality.foldedDescendantMalformedLines ?? 0;
  const own = corrupt - child - descendant;
  if (own < 0) {
    return undefined;
  }
  const sites = [
    own > 0 ? ImportParseDegradedSite.MainTranscript : null,
    child > 0 ? ImportParseDegradedSite.FoldedChild : null,
    descendant > 0 ? ImportParseDegradedSite.FoldedDescendant : null,
  ].filter((site) => site !== null);
  if (sites.length === 0) {
    return undefined;
  }
  return sites.length === 1 ? sites[0] : ImportParseDegradedSite.Multiple;
}
