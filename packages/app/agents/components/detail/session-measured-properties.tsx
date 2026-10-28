"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { hasRecordedTokenUsage } from "@repo/app/agents/lib/cost-availability";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { TRACE_PREFIX_COUNTED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { ActivityIcon, GaugeIcon, HashIcon } from "lucide-react";
import { PropertyValue } from "./property-values";
import {
  joinPropertySentences,
  resolveMetricProvenanceNote,
  SessionProvenanceMetric,
} from "./session-metric-provenance";
import {
  SESSION_TOKENS_POPULATION_NOTE,
  SESSION_TURNS_POPULATION_NOTE,
} from "./session-population-notes";
import { SESSION_TOKENS_PROPERTY_LABEL } from "./session-property-labels";
import {
  resolveSessionAutonomyExplanation,
  SessionAutonomyValue,
} from "./values/session-autonomy-value";
import { SessionTokenCountValue } from "./values/session-token-count-value";

/**
 * ISS-5565: the three session-detail Properties rows whose values are COUNTED
 * rather than declared — Autonomy, Tokens, and Work. Extracted from
 * `agent-session-detail-view.tsx` into their
 * own sibling, the same move `SessionDurationProperty` (FEA-4275) and
 * `SessionLocPerDollarProperty` (ISS-4667) made, so the empty semantics they now
 * share live in one testable place and the hot file shrinks.
 *
 * They are grouped because they had one bug in common: every one of them coerced
 * an absent count to `0` with `?? 0`. On `AgentSessionDetail` all of these fields
 * are `number | null | undefined`, and null is a REAL state — the counter was
 * never recorded, which is not the same claim as "we counted, and it was zero".
 * `packages/app/AGENTS.md` states the invariant directly ("Loading ≠ unavailable
 * ≠ not-applicable ≠ real zero"), and the sibling Sessions LIST already honours
 * it for Autonomy (`session-cell-renderers.tsx`, `row.autonomy == null` → the shared
 * `GridEmptyValue`). The detail did not, so the same session read `—` in the list
 * and "Unknown autonomy | 0/100" on the detail — the word said unknown while the
 * number said measured-at-the-floor, and a reader takes the number.
 *
 * The affordance here is deliberately the SAME shared `GridEmptyValue` the list
 * uses rather than a third rendering of "no value": these rows are reached by
 * clicking the very cell that rendered the dash, so a different glyph would read
 * as a different fact about the same field.
 *
 * ISS-5636 added the third state a counter can be in, which ISS-5565 had no way
 * to say: measured, but only over the events the producer could read. See
 * {@link prefixCountedSentence}.
 *
 * PLN-2169 M2: the Autonomy value and its sentence live in
 * `values/session-autonomy-value.tsx`, built to be shared with the Details tab
 * (M3); this row is the label and the `PropertyValue` chrome around them. The
 * Tokens row likewise mounts one `SessionTokenCountValue` per counter.
 */
export function SessionAutonomyProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  return (
    <PropertyValue
      explanation={resolveSessionAutonomyExplanation(session)}
      icon={GaugeIcon}
      label="Autonomy"
    >
      <SessionAutonomyValue session={session} />
    </PropertyValue>
  );
}

/**
 * ISS-5581 (code review): WHERE the reason for a missing value lives.
 *
 * These rows first carried their reason in a native `title` on the dash, which
 * is hover-only and unreachable by keyboard — and this change would have added
 * six more instances of that. The reason now rides `PropertyValue`'s
 * `explanation` instead: the affordance ISS-4654 already built for exactly this
 * problem, which renders a portaled DS tooltip from a FOCUSABLE button and
 * appends the sentence to the row's accessible name. Same words, reachable by
 * keyboard and assistive tech rather than by mouse alone, and no second
 * disclosure mechanism competing with the one the Status row already uses.
 *
 * One sentence per ROW, not per counter. The dashes therefore carry no `title`
 * of their own, which also retires the fragmentary "Not recorded" that used to
 * sit beside three full-sentence siblings saying the same kind of thing.
 */
function notRecordedSentence(missing: readonly string[]): string | undefined {
  return countersSentence(missing, "were not recorded for this session");
}

/**
 * ISS-5565: the Tokens row. All four counters are independently nullable, so the
 * row degrades per counter rather than all-or-nothing — a session that recorded
 * input/output but no cache breakdown should still show what it does know. When
 * NOTHING was recorded the whole row collapses to one dash instead of printing
 * "— in | — out | — cache read | — cache write", which is four shrugs where one
 * will do.
 *
 * ISS-5637: that collapse was keyed on all four counters being `null`, which
 * NEITHER producer can emit — the cloud reads four `BigInt @default(0)` columns
 * through a `toNumber` that maps null to `0` (`projections.ts`), and the desktop
 * folds `sumTokenUsage` out of `zeroTotals()` (`session-usage-totals.ts`). The
 * unknown state was therefore unreachable and a session with no token-usage rows
 * printed the fabricated measured claim `0 in | 0 out | 0 cache read | 0 cache
 * write` — two rows above a Cost dash whose ISS-5572 tooltip says "No token
 * usage recorded to price". One panel, two contradictory statements about one
 * session.
 *
 * The row now asks the evidence question the Cost row already asks, through the
 * SAME `hasRecordedTokenUsage` predicate, so the two cannot diverge again. Note
 * the deliberate asymmetry: the collapse is decided on the SUMMED quadruple,
 * while the per-counter degradation below stays per counter. A zero
 * `cacheWrite` inside a session that consumed real input tokens is a MEASURED
 * zero and keeps rendering as `0`; making every zero read as unknown would swap
 * one lie for the opposite one.
 *
 * The ISS-5565 all-null case is subsumed rather than dropped: four coalesced
 * nulls sum to zero, so a version-skewed producer that omits every counter still
 * lands on the same one-dash unknown.
 *
 * ISS-7175 (Cosimo, 2026-08-22): this row keeps the plain noun "Tokens". It shows
 * the four counters BROKEN OUT and never states their sum, so "Total" would name
 * the one thing it does not render. The total's name lives on the element that
 * actually reports it — the Session Timeline strip beside this panel, which
 * prints the summed figure and now carries the unit "total tokens". See
 * {@link SESSION_TOKENS_PROPERTY_LABEL}.
 */
export function SessionTokensProperty({
  discloseEvidence,
  session,
}: {
  /**
   * ISS-7427 (AC4): the evidence-disclosure gate, threaded from the panel rather
   * than read from a hook here, matching `getTraceCountLabel`'s contract — one
   * read for the three rows that share the gate, and a row that stays drivable
   * from a literal without a flag provider. Absent/false means say nothing.
   */
  discloseEvidence?: boolean;
  session: AgentSessionDetail;
}) {
  const honestUnknown = useFeatureFlagEnabledOptional(
    SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY
  );
  const populationDisclosed = useFeatureFlagEnabledOptional(
    SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY
  );
  const missing = [
    session.tokensIn == null ? "input tokens" : null,
    session.tokensOut == null ? "output tokens" : null,
    session.cache == null ? "cache reads" : null,
    session.cacheWrite == null ? "cache writes" : null,
  ].filter((name): name is string => name !== null);
  // The row's OWN four values, mapped onto the shared predicate's names. It
  // judges the numbers it is about to render rather than the Cost row's parallel
  // copies of them, so it can never print a quadruple it has just called
  // unrecorded. Both producers assign the two families from one summed source,
  // so the two rows reach one verdict on real sessions.
  const recordedUsage = hasRecordedTokenUsage({
    inputTokens: session.tokensIn,
    outputTokens: session.tokensOut,
    cacheReadTokens: session.cache,
    cacheWriteTokens: session.cacheWrite,
  });
  const recordedNothing = honestUnknown ? !recordedUsage : missing.length === 4;

  return (
    <PropertyValue
      explanation={joinPropertySentences(
        recordedNothing
          ? "Token counts were not recorded for this session"
          : notRecordedSentence(missing),
        // ISS-7737: the population rides the row only when the row counted
        // something. Naming what an unrecorded row WOULD have counted describes
        // a measurement that never happened — the same reason
        // `resolveSessionAutonomyExplanation` refuses to qualify a score it
        // never recorded.
        //
        // Keyed on the EVIDENCE, not on `recordedNothing`, which was the
        // review's catch: `recordedNothing` is the evidence question only while
        // ISS-5637's separate flag is on, and falls back to a per-counter null
        // NEITHER producer can emit. With that flag off — an independent Labs
        // toggle and an independent PostHog key — a zero-usage session prints
        // the fabricated `0 in | 0 out | 0 cache read | 0 cache write`, and
        // gating on `recordedNothing` would have put this sentence underneath
        // it, vouching for the four zeros as a count of every round-trip.
        populationDisclosed && recordedUsage
          ? SESSION_TOKENS_POPULATION_NOTE
          : undefined,
        // ISS-7427 (AC4): `!recordedNothing` is the row's own verdict on the
        // quadruple it is about to paint, so the provenance sentence can never
        // describe a figure the row has just replaced with its empty affordance.
        // A partially-degraded row (some counters dashed, some real) still
        // renders numbers, so it still owes the reader their source.
        resolveMetricProvenanceNote({
          disclosureEnabled: discloseEvidence === true,
          evidenceCoverage: session.evidenceCoverage,
          metric: SessionProvenanceMetric.Tokens,
          // AND the usage predicate, not just the paint verdict: with the
          // ISS-5637 honesty flag off, `recordedNothing` falls back to a
          // per-counter null NEITHER producer emits, so a zero-usage session
          // paints "0 in | 0 out | 0 cache read | 0 cache write" — and a
          // provenance sentence on that would attribute a source to a fabricated
          // zero. The two flags are independent and both default off, so this
          // row cannot assume its sibling is on.
          valueIsSourceBacked:
            !recordedNothing &&
            hasRecordedTokenUsage({
              inputTokens: session.tokensIn,
              outputTokens: session.tokensOut,
              cacheReadTokens: session.cache,
              cacheWriteTokens: session.cacheWrite,
            }),
        })
      )}
      icon={HashIcon}
      label={SESSION_TOKENS_PROPERTY_LABEL}
      mono
    >
      {recordedNothing ? (
        <GridEmptyValue />
      ) : (
        <>
          <SessionTokenCountValue
            usageRecorded={!recordedNothing}
            value={session.tokensIn}
          />{" "}
          in |{" "}
          <SessionTokenCountValue
            usageRecorded={!recordedNothing}
            value={session.tokensOut}
          />{" "}
          out |{" "}
          <SessionTokenCountValue
            usageRecorded={!recordedNothing}
            value={session.cache}
          />{" "}
          cache read |{" "}
          <SessionTokenCountValue
            usageRecorded={!recordedNothing}
            value={session.cacheWrite}
          />{" "}
          cache write
        </>
      )}
    </PropertyValue>
  );
}

/**
 * ISS-5565: the Work row. `steeringEpisodes` is `Int?` in the schema, so a null
 * is a real state and "0 steers" asserted a measured absence of human steering
 * that was never measured — the single most misleading of the three, because a
 * fully-autonomous run and an unrecorded one read identically.
 *
 * `turns` keeps its `turnItems.length` fallback: that is a genuine derivation
 * from data on the same record, not a coercion, and it only gives up when there
 * is no transcript to count either. `toolCallsTotal ?? toolUseCount` is
 * untouched — `toolUseCount` is non-nullable on the detail record, so that
 * coalesce always resolves to a real count and never fabricates one.
 *
 * Like Tokens, the row collapses to ONE dash when it knows nothing, rather than
 * printing "— turns | 0 tool calls | — steers" — two shrugs strung on pipes
 * around a zero, which scans as a broken row rather than an honest one.
 * `isEmptyCellValue`'s docstring in `grid-table.tsx` makes the same argument
 * about stacked dashes for the card builder.
 *
 * The collapse is deliberately gated on the tool-call count being zero as well.
 * `toolUseCount` cannot be null, so a nonzero count is a MEASURED fact; hiding
 * "12 tool calls" because its two neighbours were never recorded would trade
 * one dishonesty for another. With real tool calls the row keeps degrading per
 * counter — the same all-or-nothing-vs-per-counter split Tokens uses.
 *
 * ISS-5636: which of the three counters the truncation qualifier may name is
 * decided per counter for the same reason. `steeringEpisodes` is folded from
 * the bounded event rows, and so is the `turnItems.length` FALLBACK — but a
 * `session.turns` read off session metadata is not, and neither is the
 * tool-call count, which ISS-5407 already re-reads on a whole-run basis. Naming
 * all three would hedge two numbers that need no hedge.
 */
export function SessionWorkProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  const populationDisclosed = useFeatureFlagEnabledOptional(
    SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY
  );
  const turns = session.turns ?? session.turnItems?.length ?? null;
  const toolCalls = session.toolCallsTotal ?? session.toolUseCount;
  const missing = [
    turns == null ? "turns" : null,
    session.steeringEpisodes == null ? "steering episodes" : null,
  ].filter((name): name is string => name !== null);
  const recordedNothing = missing.length === 2 && !toolCalls;
  const prefixCounted = [
    // The `turnItems.length` FALLBACK is folded from the served event prefix, so
    // it is the RAW-READ flag that describes it. A `session.turns` read off
    // session metadata is not, and neither is the tool-call count, which
    // ISS-5407 already re-reads on a whole-run basis.
    session.eventsTruncated && turns != null && session.turns == null
      ? "turns"
      : null,
    // ISS-5636: its own flag, because a headless or transcript-backed session
    // counts steering off inputs the event cap never touched.
    session.steeringEpisodesTruncated && session.steeringEpisodes != null
      ? "steering episodes"
      : null,
  ].filter((name): name is string => name !== null);

  return (
    <PropertyValue
      explanation={joinPropertySentences(
        recordedNothing
          ? "Work counts were not recorded for this session"
          : notRecordedSentence(missing),
        prefixCountedSentence(prefixCounted),
        // ISS-7737: only the turn count has a population worth naming here, and
        // only when the RECORDED one is shown — the sentence exists to stop a
        // reader dividing the Tokens/Cost fold by THIS number, and a row with no
        // turn count offers nothing to divide by.
        //
        // Gated on `session.turns`, never on the resolved `turns`: the
        // `turnItems.length` fallback counts RENDER ROWS from a six-variant
        // union (sessionstart, prompt, say, tools, subagent, event), so it is
        // neither a recorded turn count nor parent-only. Naming it "parent
        // turns" would vouch for a population it does not describe — the exact
        // mis-division this note exists to prevent.
        populationDisclosed && !recordedNothing && session.turns != null
          ? SESSION_TURNS_POPULATION_NOTE
          : undefined
      )}
      icon={ActivityIcon}
      label="Work"
    >
      {recordedNothing ? (
        <GridEmptyValue />
      ) : (
        <>
          {turns == null ? <GridEmptyValue /> : turns} turns | {toolCalls} tool
          calls |{" "}
          {session.steeringEpisodes == null ? (
            <GridEmptyValue />
          ) : (
            session.steeringEpisodes
          )}{" "}
          steers
        </>
      )}
    </PropertyValue>
  );
}

/**
 * One sentence naming a set of counters, or `undefined` for an empty set.
 *
 * Every counter name callers pass is a PLURAL noun so the compound subject
 * always takes "were", and the list needs no singular/plural agreement logic to
 * stay grammatical at one, two, or four names.
 */
function countersSentence(
  counters: readonly string[],
  predicate: string
): string | undefined {
  if (counters.length === 0) {
    return undefined;
  }
  const subject = new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(counters);
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${predicate}`;
}

/**
 * ISS-5636: the same shape for the OTHER thing a counter can be, which these
 * rows previously had no way to say — measured, but over a partial event stream.
 *
 * The desktop's local detail read is bounded at `SESSION_DETAIL_EVENT_MAX_ROWS`
 * and folds some counters out of the rows it got, so past that ceiling those are
 * prefix counts rendered as bare whole-run stats — while the SAME session's
 * Sessions-list row folds the full stream. The cloud reads each counter off a
 * persisted column the cap never touches, sets none of these flags, and its
 * numbers keep reading unqualified.
 *
 * WHICH counters may be named is decided per counter, by the flag scoped to the
 * derivation that produced it — never by one flag standing in for the set. A
 * headless run's steering is a fixed `0` and a transcript-backed session's is
 * counted off the whole message stream; both are complete past the ceiling, and
 * hedging them would be as wrong as not hedging the counts that are prefixes.
 */
function prefixCountedSentence(counted: readonly string[]): string | undefined {
  return countersSentence(counted, `were ${TRACE_PREFIX_COUNTED_NOTE}`);
}
