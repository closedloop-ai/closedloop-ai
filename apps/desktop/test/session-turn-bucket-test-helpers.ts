/**
 * @file session-turn-bucket-test-helpers.ts
 * @description Shared setup for the `deriveSessionTurnBuckets` suites.
 *
 * ISS-8398 split the timestamp-reading cases out of
 * session-turn-bucket-derive.test.ts when they pushed it past the 1,000-line
 * ceiling. These four symbols are what both suites need, and they live here
 * rather than in each file so the two `hasTokenEvents` explanations — which
 * describe one production invariant — cannot drift apart.
 */

export const meta = (o: Record<string, unknown>) => JSON.stringify(o);

/** A canonical parent token record (FEA-3597: no `subagentId` ⇒ parent). */
export const tokenRecord = (v: string) => ({
  timestamp: v,
  model: "m",
  input: 1,
  output: 1,
});

/**
 * The PRODUCTION value of `hasTokenEvents` for any session carrying a NON-EMPTY
 * `$.tokenSeries`. The importer writes one `token_events` row per series entry —
 * `import-session-context.ts` builds `tokenEventsRecords` as
 * `tokenSeries.length > 0 ? tokenSeries : <synthesized from $.tokensByModel>` —
 * so "has a series" and "has token events" are the SAME state on any store the
 * importer wrote.
 *
 * ISS-8259 review (davetho) made the agent half an if/else on this flag, to
 * match the cloud, which splits on token-event presence alone. A series-bearing
 * fixture must therefore pass this, or it is not describing a store the importer
 * can produce — it is describing a partial one, and asserting round-trip
 * behavior against it would pin a state the production caller never passes.
 */
export const SYNCED_TOKEN_EVENTS = true;

/** No `token_events` row synced — the population the legacy `$.messages` Agent
 * fallback exists for, and the only one that reaches it. */
export const NO_TOKEN_EVENTS = false;
