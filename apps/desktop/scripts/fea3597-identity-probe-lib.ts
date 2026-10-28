/**
 * ISS-5303 — the pure decision logic behind `scripts/fea3597-identity-probe.mts`.
 *
 * The probe itself is a top-level-await script: importing it PARSES the whole
 * golden corpus, prints a table, and can `process.exit(1)`. Nothing in it is
 * reachable from a test. This module is the half that is: no I/O, no console,
 * no module-scope mutable state, nothing that runs on import. The probe keeps
 * the corpus walk, the tallies, and the exit codes.
 */

/** The PRE-FEA-3597 human/agent split, per session metadata. */
export type OldRuleCounts = {
  human: number;
  agent: number;
};

/**
 * Reference agent-unit counts from the FEA-3597 operator ruling, keyed by the
 * first 8 characters of the dossier's session id. Only the dossiers the ruling
 * actually names appear here; every other dossier is unflagged.
 */
export const RULING_AGENT_COUNTS: Readonly<Record<string, number>> =
  Object.freeze({
    "6d6d2e80": 82,
    "56f2ab4a": 65,
    cc6c71e9: 25,
  });

/** One dossier's ruling verdict: the row suffix, plus whether it disagreed. */
export type RulingFlag = {
  /** Suffix appended to the probe's table row. Empty when unflagged. */
  label: string;
  /** True only when the ruling names this dossier AND the count disagrees. */
  mismatch: boolean;
};

/**
 * The PRE-FEA-3597 rule, kept verbatim so the probe compares against a real
 * oracle rather than a paraphrase of one.
 *
 * A "headless" session (SDK entrypoint, an exec-style entrypoint, or
 * `bypassPermissions`) has no human at the keyboard, so its `human` messages
 * are counted as agent turns. Messages that are not objects, carry neither the
 * `human` nor the `assistant` role, or lack a usable timestamp are skipped —
 * this reads a JSON round-trip of stored metadata TEXT, so every field is
 * genuinely `unknown` and malformed shapes are reachable.
 */
export function oldRule(meta: Record<string, unknown>): OldRuleCounts {
  const messages = Array.isArray(meta.messages) ? meta.messages : [];
  const entrypoint =
    typeof meta.entrypoint === "string" ? meta.entrypoint.toLowerCase() : "";
  const permissionMode =
    typeof meta.permissionMode === "string" ? meta.permissionMode : "";
  const headless =
    entrypoint.startsWith("sdk-") ||
    entrypoint.includes("exec") ||
    permissionMode === "bypassPermissions";
  let human = 0;
  let agent = 0;
  for (const el of messages) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { role, timestamp } = el as { role?: unknown; timestamp?: unknown };
    if (role !== "human" && role !== "assistant") {
      continue;
    }
    if (typeof timestamp !== "string" && typeof timestamp !== "number") {
      continue;
    }
    if (role === "human" && !headless) {
      human += 1;
    } else {
      agent += 1;
    }
  }
  return { human, agent };
}

/**
 * Check one dossier's new agent count against the operator ruling.
 *
 * Returns the mismatch as data rather than incrementing a counter: the probe
 * owns its tallies, and a lib that mutated module state on call could not be
 * driven twice from one test process.
 *
 * `Object.hasOwn` rather than a bare index read — the short id is derived from
 * data, and an inherited `Object.prototype` key must not resolve to a
 * "expectation" that no ruling ever made.
 */
export function rulingFlag(
  shortId: string,
  newAgent: number,
  expectedByShortId: Readonly<Record<string, number>> = RULING_AGENT_COUNTS
): RulingFlag {
  if (!Object.hasOwn(expectedByShortId, shortId)) {
    return { label: "", mismatch: false };
  }
  const expected = expectedByShortId[shortId];
  if (expected === undefined) {
    return { label: "", mismatch: false };
  }
  if (expected === newAgent) {
    return { label: `  ✓ ruling ${expected}`, mismatch: false };
  }
  return { label: `  ✗ ruling expected ${expected} — FAIL`, mismatch: true };
}

/**
 * ISS-8397 — derive `hasTokenEvents` from parsed metadata, mirroring the
 * importer's rule (import-session-context.ts:117) and the golden-layer2
 * reference (golden-layer2.ts:170 `expectedTokenEvents`).
 *
 * The predicate is: would the importer have written token_events rows for this
 * session? That happens when `tokenSeries` has entries with truthy timestamps,
 * OR when `tokensByModel` has entries (synthesized records use `startedAt` as
 * their timestamp — truthy startedAt means the records pass the filter).
 *
 * SCOPE — this models a FIRST import, which is all the probe can observe: it
 * re-parses each frozen dossier from `raw/` with no database and no prior rows,
 * so "would rows exist" can only mean "would this parse write them". A REPARSE
 * can diverge, and deliberately so: `importPhaseTokenEventsAndCosts` returns
 * early when the derivation is empty (write-core-import-phases-usage.ts:90), so
 * a session that reparses to zero models PRESERVES the token_events rows an
 * earlier import wrote, and the real rebuild would still read the round-trip
 * arm where this returns false. Reaching that case needs prior persisted state
 * the probe does not have.
 *
 * This replaces the hardcoded `false` the probe used to pass to
 * `deriveSessionTurnBuckets`. ISS-8259 turned that argument into the ARM
 * SELECTOR, so a literal `false` forces the legacy `$.messages` arm for every
 * session — correct for the 4 token-event-less dossiers, wrong for the other 23.
 */
export function deriveHasTokenEvents(meta: Record<string, unknown>): boolean {
  const series = Array.isArray(meta.tokenSeries) ? meta.tokenSeries : [];
  if (series.length > 0) {
    return series.some(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        !Array.isArray(e) &&
        Boolean((e as Record<string, unknown>).timestamp)
    );
  }
  // No tokenSeries — check whether tokensByModel would synthesize records.
  // The importer's fallback timestamp is `session.startedAt ?? now`
  // (import-session-context.ts:117), and `now` is always a non-empty instant,
  // so a synthesized record ALWAYS clears write-core's skip-on-missing-
  // timestamp rule. `startedAt` is therefore not part of the predicate:
  // `startedAt: string | null` (agent-db-contract.ts:19) is genuinely nullable
  // and a null one still persists rows. golden-layer2's `startedAt ?? ""`
  // re-derivation drops them instead; that divergence is its own, and this
  // helper follows the writer, which is what "token_events row presence" means.
  const tbm = meta.tokensByModel;
  if (typeof tbm !== "object" || tbm === null || Array.isArray(tbm)) {
    return false;
  }
  return Object.keys(tbm as object).length > 0;
}

/** One dossier's agent-unit oracle, split by attribution. */
export type AgentOracleCounts = {
  /**
   * Every qualifying `$.tokenSeries` round-trip, parent- AND subagent-marked
   * alike. This is what `collectAgentUnits` counts today (ISS-5395), so it is
   * the oracle the `$.tokenSeries` arm is held to.
   */
  qualifying: number;
  /**
   * `qualifying` minus the subagent-marked records — the RETIRED FEA-3597
   * "Option A" quantity. Kept because the operator ruling in
   * {@link RULING_AGENT_COUNTS} was made about this number, and comparing that
   * ruling against `qualifying` would silently restate it.
   */
  parentOnly: number;
  /** Records carrying a `subagentId` marker. */
  marked: number;
};

/**
 * ISS-8397 — the probe's independent re-derivation of the agent-unit count
 * from stored metadata, deliberate double-entry against `collectAgentUnits`.
 *
 * `subagentId` is NOT an exclusion. ISS-5395 removed that filter from the
 * production rule: all three folding harnesses remove a subagent from the
 * top-level session list, so the child has no `sessions` row to carry its
 * round-trips and excluding them LOST the work rather than re-homing it
 * (turn-buckets.ts header). The probe's oracle predates that correction and
 * still subtracted them, so with the `$.tokenSeries` arm actually selected it
 * reported a false identity failure on every dossier that folds a subagent.
 *
 * The timestamp guard stays an independent expression rather than an import of
 * the production predicate — a re-derivation that calls the thing it checks
 * proves nothing.
 */
export function countAgentOracleEntries(
  meta: Record<string, unknown>
): AgentOracleCounts {
  const series = Array.isArray(meta.tokenSeries) ? meta.tokenSeries : [];
  let qualifying = 0;
  let parentOnly = 0;
  let marked = 0;
  for (const el of series) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const r = el as { subagentId?: unknown; timestamp?: unknown };
    if (
      !(
        typeof r.timestamp === "string" &&
        Number.isFinite(Date.parse(r.timestamp))
      )
    ) {
      continue;
    }
    qualifying += 1;
    if (r.subagentId === undefined) {
      parentOnly += 1;
    } else {
      marked += 1;
    }
  }
  return { qualifying, parentOnly, marked };
}
