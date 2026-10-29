import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";

/**
 * ISS-7427 (AC4): where the session-detail Properties panel's three headline
 * numbers — Cost, Tokens, Duration — actually came from, said out loud on the
 * one session state where nothing will ever reconcile them against a transcript.
 *
 * The reported screen showed $5,994.85, 8.99B tokens and 770h 55m beside a panel
 * reading "Transcript not archived". The audit (#5584) established the numbers
 * are neither fabricated nor transcript-derived: the metadata lane
 * (`agent-sessions` sync) writes `estimatedCost`, the four token columns and
 * `sessionStartedAt`/`sessionEndedAt` on a path the blob lane never gates. So
 * this is a DISCLOSURE contract like its two siblings, not an arithmetic one —
 * the count's provenance shipped in #5686 and the strip's extent in #5793, and
 * these three are the values those two left unlabelled.
 *
 * A pure leaf with no JSX, for the reason `session-trace-header.ts` and
 * `session-timeline-coverage.ts` are: the rows that consume it are `"use client"`
 * components, and the decision is testable without mounting one.
 *
 * EACH NOTE CLAIMS ONLY ITS OWN VALUE'S PROVENANCE, and that restraint is the
 * design rather than brevity. It is the trap #5793 hit twice: a claim about what
 * EXISTS is surface-dependent, a claim about where a number CAME FROM is not.
 * `metadataOnly` describes the CLOUD main archive, and such a session can still
 * carry readable subagent archives (one of the four signals that produce the
 * state) or, on desktop, an on-disk `.jsonl` the panel paints in full. So none
 * of these sentences may say a transcript does not exist — only that this number
 * was not read from one, which stays true on every surface.
 */

/** The three Properties rows this ticket owes a provenance sentence. */
export const SessionProvenanceMetric = {
  Cost: "cost",
  Duration: "duration",
  Tokens: "tokens",
} as const;
export type SessionProvenanceMetric =
  (typeof SessionProvenanceMetric)[keyof typeof SessionProvenanceMetric];

/**
 * What each row says about itself when the main archive is terminally absent.
 *
 * THREE SENTENCES, NOT ONE, because the three values have different sources and
 * a single sentence would have to be vague enough to be true of all of them.
 * Cost and Tokens share the usage rollup — Cost is that rollup priced — while
 * Duration is two timestamps on the session record and touches usage at no
 * point. Naming the actual source is the whole disclosure; "derived from
 * metadata" would name the lane and tell the reader nothing they could check.
 *
 * Full sentences, unlike `TRACE_COUNT_METADATA_ONLY_NOTE`'s fragment, because
 * these ride `PropertyValue`'s `explanation` and compose with the rows' existing
 * reason sentences through {@link joinPropertySentences}, where that file's
 * middot-joined caption fragment would read as a different register.
 *
 * PROPOSED WORDING. The gate is closed by default and the final phrasing is the
 * operator's call, not this module's — the same footing #5686 and #5793 shipped
 * their copy on.
 */
const METADATA_ONLY_NOTE: Record<SessionProvenanceMetric, string> = {
  [SessionProvenanceMetric.Cost]:
    "Priced from synced usage, not the transcript",
  // NAMES THE START ONLY, and that is load-bearing rather than terse. A running
  // session's Duration is measured `startedAt → now` (`SessionDurationWindow`'s
  // `running` arm), so it has NO recorded end — and `metadataOnly` never
  // consults lifecycle, while a `too_large` skip can fire mid-run, so the state
  // is reachable. An earlier draft said "recorded start and end" and was
  // therefore false on a live session whose number is visibly ticking three rows
  // under a Status of "Active". `session_started_at` is NOT NULL and is the
  // anchor BOTH window arms measure from, so naming it alone is true of both.
  [SessionProvenanceMetric.Duration]:
    "Timed from the recorded start, not the transcript",
  [SessionProvenanceMetric.Tokens]:
    "Counted from synced usage, not the transcript",
};

/**
 * The sentence a given metric would state, regardless of gating.
 *
 * Exported for the specs that pin WHICH note reaches WHICH row: asserting the
 * substring all three share let the three production call sites swap metrics
 * with every test still green, which is how a Duration ends up captioned
 * "priced from synced usage". The map itself stays private so a caller cannot
 * enumerate it and re-derive the fold's gating.
 */
export function metricProvenanceNote(metric: SessionProvenanceMetric): string {
  return METADATA_ONLY_NOTE[metric];
}

export type SessionMetricProvenanceInput = {
  /** The resolved gate, as `useFeatureFlagEnabledOptional` returns it. */
  disclosureEnabled: boolean;
  /**
   * The server's verdict, straight off the detail response.
   *
   * `undefined` means THIS SERVER DOES NOT CLASSIFY (a version-skewed
   * `apps/api`, or the desktop-local projection, which never sets it) — never
   * "the main archive is readable". An unclassified response says nothing rather
   * than guessing, matching the wire contract on
   * `AgentSessionDetail.evidenceCoverage`.
   */
  evidenceCoverage: AgentSessionDetail["evidenceCoverage"];
  /** Which row is asking. */
  metric: SessionProvenanceMetric;
  /**
   * Whether the row is about to render a figure THAT THE SOURCE THIS NOTE NAMES
   * ACTUALLY RECORDED. Two conditions, deliberately, because they come apart.
   *
   * A row showing its empty affordance has no provenance to state — there is no
   * value on screen for the sentence to be about — and it already carries a
   * reason of its own ("Token counts were not recorded for this session").
   *
   * The second condition is the one a plain "is a figure painted?" misses: a
   * FABRICATED ZERO is painted like any other number. `hasRecordedTokenUsage`
   * being false means the whole rollup is zero, and the server says in as many
   * words that it cannot tell such a lane apart from one that wrote a truthful
   * zero ("every rollup column defaults to 0, so a lane that wrote nothing and a
   * lane that wrote a truthful zero are the same bytes here",
   * `session-evidence-coverage-constants.ts`). Attaching "counted from synced
   * usage totals" there would assert a measurement source exactly where the
   * producer disclaims the ability to distinguish one — a provenance label on a
   * number nobody measured, which is the defect class this ticket exists to
   * close rather than a new instance of it. So the two usage-backed rows,
   * Cost and Tokens, AND their paint verdict with that predicate.
   *
   * Duration is exempt from the usage half on purpose: it is timed from
   * `session_started_at`, a NOT NULL column the usage rollup never feeds, so a
   * zero-usage session's Duration is still a real measurement.
   *
   * The row decides this from the values it is itself about to paint, never from
   * a parallel copy of them, which is the rule `SessionTokensProperty` already
   * states for its own collapse.
   */
  valueIsSourceBacked: boolean;
};

/**
 * Resolve one row's provenance sentence, or `null` for every state that may not
 * carry one.
 *
 * Gated on `metadataOnly` alone, and the four exclusions are the point of the
 * ticket — the same fold `resolveTimelineCoverageLegend` applies to the strip:
 *
 * - `mainReadable` — the archive is there, so a reader who wants to reconcile
 *   these numbers against it can. A standing provenance note on every healthy
 *   session would be noise, and it is what makes this gate narrow enough to be
 *   worth reading when it does appear.
 * - `pending` — nothing has been ruled out; the archive may still land, and
 *   saying the numbers are not from it would be false the moment it does.
 * - `noEvidence` — every independent signal is empty, so no figure renders and
 *   {@link SessionMetricProvenanceInput.valueIsSourceBacked} refuses it anyway.
 * - `notApplicable` — no transcript was ever expected, so its absence says
 *   nothing about where these numbers came from.
 */
export function resolveMetricProvenanceNote(
  input: SessionMetricProvenanceInput
): string | null {
  if (!input.disclosureEnabled) {
    return null;
  }
  if (input.evidenceCoverage !== SessionEvidenceCoverage.MetadataOnly) {
    return null;
  }
  if (!input.valueIsSourceBacked) {
    return null;
  }
  return METADATA_ONLY_NOTE[input.metric];
}

/**
 * Join a Properties row's reason sentences into the ONE `explanation` string its
 * contract allows, or `undefined` when it has none.
 *
 * Moved here from `session-measured-properties.tsx` (where it was private) so
 * the rows in the sibling files that now need it — Cost in
 * `session-properties-panel.tsx`, Duration in `session-duration-property.tsx` —
 * compose their sentences the same way rather than each growing a copy. The
 * one-sentence-per-ROW rule ISS-5581 established is what makes a joiner the
 * right shape: a row's reasons are additive facts about one value, and
 * `PropertyValue` renders exactly one accessible statement of them.
 *
 * A single surviving sentence is returned VERBATIM, so a row carrying only its
 * pre-existing reason renders the byte-identical string it renders today.
 */
export function joinPropertySentences(
  ...sentences: readonly (string | null | undefined)[]
): string | undefined {
  const stated = sentences.filter(
    (sentence): sentence is string =>
      typeof sentence === "string" && sentence.length > 0
  );
  return stated.length > 0 ? stated.join(". ") : undefined;
}
