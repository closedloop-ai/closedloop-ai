/**
 * Inclusive `created_at` bounds for the branch usage event scan (ISS-4941).
 * Both ends are expected to be canonical `toISOString()` strings, so SQLite's
 * string comparison against the stored column is chronological (the app only
 * ever persists `toISOString()` — see this directory's AGENTS.md
 * date-comparison rule). A bound outside that fixed-width shape is not pushed
 * down at all — see `branchUsageEventWindowSql`.
 */
export type BranchUsageEventWindowBounds = {
  startIso?: string;
  endIso?: string;
};

/**
 * The canonical `toISOString()` instant: fixed-width, FOUR-digit year, hour
 * `00`-`23`, `Z` suffix. Exactly the shape for which a byte-wise comparison is
 * chronological AND agrees with `Date.parse`, which is what makes the pushdown
 * a superset of the JS filter. `Date.parse` accepts more than this — an
 * expanded year (`+010000-01-01T00:00:00.000Z`, which sorts lexically BEFORE
 * every four-digit year because `+` < `0`) and hour `24` (which it rolls into
 * the next day while a byte-wise compare does not) both order differently.
 */
const CANONICAL_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The same fixed-width shape as a SQLite `GLOB` pattern. `GLOB` has no
 * alternation, so the hour's `00`-`23` half is carried by a separate `substr`
 * comparison at the call site (both operands are two digits there, so the
 * string compare IS the numeric one).
 */
const CANONICAL_INSTANT_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";

/**
 * ISS-4941: push the request date window onto `token_events.created_at` so a
 * windowed usage/analytics read scans only the in-window slice. `token_events`
 * is the highest-cardinality table (one row per turn), so hydrating it whole on
 * every usage-card render violates the FEA-2038 metadata-only-aggregate
 * invariant and pressures the heap-capped db-host `utilityProcess`. The cloud
 * twin bounds the equivalent `agentSessionTokenEvent` read the same way, in the
 * query (`branch-cost-evidence-reader.ts`).
 *
 * A PROVABLE SUPERSET of the JS `filterEventRowsByEventWindow`, which still runs
 * and makes the final in/out call — SQL only stops hydrating rows that filter
 * could never have kept. Both SIDES of the comparison are restricted to
 * `CANONICAL_INSTANT_RE`'s fixed-width shape to buy that guarantee, because a raw
 * SQLite string comparison is NOT the same function as the JS `Date.parse`
 * comparison:
 *
 *  - The STORED value must match the shape (`GLOB` + the `substr` hour guard) AND
 *    round-trip SQLite's own `toISOString()` rendering; any row that fails either
 *    check is kept unconditionally. That covers an offset-form instant
 *    (`…T01:00:00.000+02:00`, which sorts lexically past a `Z` bound it is
 *    chronologically inside of), a missing-ms or date-only value, an unparseable
 *    string, an hour-`24` value (which SQLite echoes back verbatim while
 *    `Date.parse` rolls it into the next day), and a shaped-but-impossible one
 *    (`2026-02-30T…`, which SQLite silently rolls forward and `Date.parse`
 *    rejects). Those rows reach JS, so the cost-completeness fold still sees the
 *    invalid-timestamp rows it reports as incomplete coverage
 *    (`buildDesktopBranchCostEvidence`), and no in-window spend is dropped.
 *  - The BOUND must match the same shape or it is not pushed down at all. A
 *    `Date.parse`-accepted expanded year (`+010000-01-01T00:00:00.000Z`) survives
 *    `eventWindowSqlBounds` and sorts lexically BEFORE every stored four-digit
 *    year, so comparing against it would drop the whole corpus the JS filter
 *    keeps; an unbounded scan is the safe answer instead.
 *  - For the canonical remainder — everything `toISOString()` actually writes —
 *    lexical order IS chronological order, so the bound comparison is exact.
 *
 * The `IS NULL` arm is load-bearing rather than defensive: every other arm is
 * NULL for a NULL instant (`NULL GLOB …` is NULL, and `strftime(NULL) IS NULL` is
 * TRUE so its negation is FALSE), so without it a null instant would fall through
 * and be dropped. The column is NOT NULL today, but the read's row type declares
 * `string | null` and the JS filter handles null, so the SQL agrees with them
 * rather than contradicting them.
 *
 * Trade-off: the `OR` makes this non-sargable, so `idx_token_events_session_created`
 * still can't range-seek `created_at`. That is deliberate — the bug being fixed is
 * hydrating the whole event corpus into the heap-capped db-host, and this bounds
 * the rows that cross into JS. A sargable form would have to drop one of the arms
 * above and start miscounting spend.
 *
 * The other trade-off is that the shape guards make the bound a no-op for a
 * non-canonical timestamp, so such a corpus would still hydrate whole. That is the SAFE
 * degradation (today's behavior, never a wrong number), and it is not the real
 * shape: every one of the 16,467 timestamp strings in the frozen
 * `packages/golden-sessions` corpus — Claude, Codex, and OpenCode alike — is
 * canonical `toISOString()` output. This column is also already compared
 * lexically by the incremental-import high-water mark in
 * `token-event-contract.ts`, so canonical storage is a standing assumption here
 * rather than a new one. Bounding offset forms too would mean comparing with
 * `julianday()`, which silently rolls an impossible date (`2026-02-30T…`) forward
 * instead of rejecting it the way `Date.parse` does — trading a measured non-issue
 * for a real hole in the coverage signal.
 *
 * Appends its bound values to `params`, so the caller passes them positionally
 * to `$queryRawUnsafe` rather than interpolating request text into SQL.
 */
export function branchUsageEventWindowSql(
  bounds: BranchUsageEventWindowBounds | undefined,
  params: unknown[]
): string {
  const placeholder = () => `$${params.length + 1}`;
  const inWindow: string[] = [];
  if (bounds?.startIso && CANONICAL_INSTANT_RE.test(bounds.startIso)) {
    inWindow.push(`te.created_at >= ${placeholder()}`);
    params.push(bounds.startIso);
  }
  if (bounds?.endIso && CANONICAL_INSTANT_RE.test(bounds.endIso)) {
    inWindow.push(`te.created_at <= ${placeholder()}`);
    params.push(bounds.endIso);
  }
  if (inWindow.length === 0) {
    return "";
  }
  return `AND (
           te.created_at IS NULL
           OR te.created_at NOT GLOB '${CANONICAL_INSTANT_GLOB}'
           OR substr(te.created_at, 12, 2) > '23'
           OR strftime('%Y-%m-%dT%H:%M:%fZ', te.created_at) IS NOT te.created_at
           OR (${inWindow.join(" AND ")})
         )`;
}
