"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { ActivityIcon, GaugeIcon, HashIcon } from "lucide-react";
import { getAutonomyLabel } from "../../lib/autonomy";
import { PropertyValue } from "./property-values";

/**
 * ISS-5565: the three session-detail Properties rows whose values are COUNTED
 * rather than declared — Autonomy, Tokens, and Work. Extracted from
 * `agent-session-detail-view.tsx` (a grandfathered, shrink-only file) into their
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
 * it for Autonomy (`sessions-table.tsx`, `row.autonomy == null` → the shared
 * `GridEmptyValue`). The detail did not, so the same session read `—` in the list
 * and "Unknown autonomy | 0/100" on the detail — the word said unknown while the
 * number said measured-at-the-floor, and a reader takes the number.
 *
 * The affordance here is deliberately the SAME shared `GridEmptyValue` the list
 * uses rather than a third rendering of "no value": these rows are reached by
 * clicking the very cell that rendered the dash, so a different glyph would read
 * as a different fact about the same field.
 */
export function SessionAutonomyProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  return (
    <PropertyValue
      explanation={
        session.autonomy == null
          ? "Autonomy was not recorded for this session"
          : undefined
      }
      icon={GaugeIcon}
      label="Autonomy"
    >
      {/* Matches `sessions-table.tsx`'s autonomy cell exactly: null is the empty
          affordance, never `Unknown autonomy | 0/100`. Rendering the tier word
          AND a floor number for an unmeasured score printed a contradiction —
          `getAutonomyLabel(null)` is honest on its own, but the `?? 0` beside it
          reinstated the lie the word had just avoided. A real 0 still renders
          "Guided autonomy | 0/100", which is a measured claim and stays. */}
      {session.autonomy == null ? (
        <GridEmptyValue />
      ) : (
        `${getAutonomyLabel(session.autonomy)} | ${session.autonomy}/100`
      )}
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
 *
 * Every counter name here is a PLURAL noun so the compound subject always takes
 * "were", and the list needs no singular/plural agreement logic to stay
 * grammatical at one, two, or four missing counters.
 */
function notRecordedSentence(missing: readonly string[]): string | undefined {
  if (missing.length === 0) {
    return undefined;
  }
  const subject = new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(missing);
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} were not recorded for this session`;
}

/**
 * ISS-5565: the Tokens row. All four counters are independently nullable, so the
 * row degrades per counter rather than all-or-nothing — a session that recorded
 * input/output but no cache breakdown should still show what it does know. When
 * NOTHING was recorded the whole row collapses to one dash instead of printing
 * "— in | — out | — cache read | — cache write", which is four shrugs where one
 * will do.
 */
export function SessionTokensProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  const missing = [
    session.tokensIn == null ? "input tokens" : null,
    session.tokensOut == null ? "output tokens" : null,
    session.cache == null ? "cache reads" : null,
    session.cacheWrite == null ? "cache writes" : null,
  ].filter((name): name is string => name !== null);
  const recordedNothing = missing.length === 4;

  return (
    <PropertyValue
      explanation={
        recordedNothing
          ? "Token counts were not recorded for this session"
          : notRecordedSentence(missing)
      }
      icon={HashIcon}
      label="Tokens"
      mono
    >
      {recordedNothing ? (
        <GridEmptyValue />
      ) : (
        <>
          <TokenCount value={session.tokensIn} /> in |{" "}
          <TokenCount value={session.tokensOut} /> out |{" "}
          <TokenCount value={session.cache} /> cache read |{" "}
          <TokenCount value={session.cacheWrite} /> cache write
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
 */
export function SessionWorkProperty({
  session,
}: {
  session: AgentSessionDetail;
}) {
  const turns = session.turns ?? session.turnItems?.length ?? null;
  const toolCalls = session.toolCallsTotal ?? session.toolUseCount;
  const missing = [
    turns == null ? "turns" : null,
    session.steeringEpisodes == null ? "steering episodes" : null,
  ].filter((name): name is string => name !== null);
  const recordedNothing = missing.length === 2 && !toolCalls;

  return (
    <PropertyValue
      explanation={
        recordedNothing
          ? "Work counts were not recorded for this session"
          : notRecordedSentence(missing)
      }
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
 * One token counter: its localized value, or the shared empty affordance when
 * the producer never recorded it. Kept as a component rather than a formatter
 * returning a string so the dash is the SAME `GridEmptyValue` element the rest
 * of the panel and the Sessions list use, instead of a second em-dash literal
 * that could drift from it.
 *
 * It carries no `title` of its own: the row names its missing counters once, in
 * a full sentence, through {@link notRecordedSentence}. The bare fragment
 * "Not recorded" that used to sit here read as a different register from the
 * full-sentence reasons on its sibling rows, and repeated the same fact up to
 * four times in one row.
 */
function TokenCount({ value }: { value: number | null | undefined }) {
  if (value == null) {
    return <GridEmptyValue />;
  }
  return <>{value.toLocaleString()}</>;
}
