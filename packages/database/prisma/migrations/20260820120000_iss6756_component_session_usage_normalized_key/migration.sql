-- ISS-6756: persist the case/whitespace-folded component key so the org-scoped
-- identity reads on `agent_component_session_usage` can be index-served.
--
-- WHAT IS BROKEN. Two org-scoped reads match a component identity with Prisma's
-- `componentKey: { equals: k, mode: "insensitive" }`:
--
--   apps/api/app/agent-components/analytics-service.ts    fetchTokenTrendUsageRows
--   apps/api/app/agent-components/detail-usage-reads.ts   detailOrphanUsageWhere
--
-- Prisma emits that as `component_key ILIKE $n`, and Postgres can match an
-- `ILIKE` predicate to NO btree — not even a `LOWER(component_key)` expression
-- index, which is the distinction migration 20260815120000 (ISS-6452) turns on:
-- there the predicates were raw `LOWER(col) IN (…)`, which an expression index
-- DOES serve. `ILIKE` is an operator no index on this table's columns implements,
-- so the only fix is a real column holding the folded value.
--
-- Neither read binds `agent_component_id` or `agent_session_id` first, so neither
-- can reach the indexes that already exist — `idx_acsu_session_kind_key_branch`
-- leads with `agent_session_id`, and `(component_kind, last_invoked_at)` stops at
-- the kind. And this table carries NO `organization_id` column at all: org arrives
-- through the `session.artifact` relation join. So both reads narrowed to the
-- same-kind partition ACROSS EVERY TENANT and discarded the rest with a post-scan
-- filter, then sorted on a RELATION field (`session.sessionStartedAt`) — which
-- means their `take` bounds the rows RETURNED, not the join+sort input.
--
-- WHY THE DATABASE OWNS THE FOLD, NOT THE APPLICATION. The value is derived by a
-- BEFORE INSERT/UPDATE trigger that overwrites whatever the writer supplied. Two
-- reasons, both load-bearing:
--
--   • ROLLING DEPLOY. The cloud writer (`persistSessionComponentUsage`, a raw
--     `INSERT … ON CONFLICT`) keeps running the PRE-deploy statement while this
--     migration is live and for as long as the old revision serves traffic. An
--     application-written column would leave every row that writer inserts in
--     that window holding the `''` column default, and the new reads — which
--     match on the folded column — would then be BLIND to exactly the newest
--     usage. A trigger has no such window.
--   • ONE DEFINITION. The backfill below and every future write go through the
--     same `lower(btrim(...))` function, so a backfilled row and a freshly
--     written row can never disagree about what the fold is.
--
-- The fold reproduces `normalizeComponentKey`
-- (packages/api/src/types/agent-component-analytics.ts), the cross-surface codec
-- the reads normalize their QUERY side with and the one the desktop already
-- applies to stored keys (`shared-agent-components-api.ts`), which is
-- `x.toLowerCase().trim()`.
--
-- WHY THE TRIM SET IS SPELLED OUT. One-argument `btrim(x)` strips the ASCII
-- SPACE and nothing else, while JS `trim()` strips the whole
-- WhiteSpace + LineTerminator set. A key stored as `deploy\r` — a CRLF
-- frontmatter line the collector did not strip — would then fold to `deploy\r`
-- in the database and to `deploy` in the JS fold the list uses, and the detail
-- and trend lanes would report 0 against a list row showing usage: exactly the
-- list-detail divergence this column is supposed to close, reintroduced from
-- underneath. So the character set below is JS's, enumerated: TAB, LF, VT, FF,
-- CR, SPACE, NBSP, OGHAM SPACE MARK, the EN/EM QUAD..HAIR SPACE block, LINE and
-- PARAGRAPH SEPARATOR, NARROW NO-BREAK SPACE, MEDIUM MATHEMATICAL SPACE,
-- IDEOGRAPHIC SPACE, and the BOM.
--
-- RESIDUAL, stated rather than papered over: SQL `lower()` and JS
-- `toLowerCase()` are two implementations of Unicode case folding and can differ
-- on exotic input (the Turkish dotted capital I is the usual example). That
-- difference is NOT introduced here — the `ILIKE` this replaces folded case with
-- the SAME SQL `lower()` against the same JS-lowercased query key, so the case
-- dimension is unchanged. Only the trim dimension is new, and it is exact.
--
-- BEHAVIOUR DELTA — THE ROW SET MOVES, IN BOTH DIRECTIONS. This is not a pure
-- re-spelling, and saying so is the point: a token-trend or detail number that
-- shifts on deploy IS attributable to this change.
--
--   • WIDER: the fold TRIMS and `ILIKE` did not, so a stored key with
--     surrounding whitespace matched NOTHING before and matches its trimmed
--     identity now. That is the desktop's existing behaviour, so it is parity.
--   • NARROWER: Prisma binds the key as the ILIKE PATTERN, unescaped — verified
--     against the engine, which logs `component_key ILIKE $1` with
--     `$1 = 'mcp__x__y'` — so `_` and `%` in a key were WILDCARDS. These keys
--     carry `_` constantly (`mcp__closedloop__ping`, `web_search`), so
--     `mcp__closedloop__ping` also matched `mcpXXclosedloopYYping`: a DIFFERENT
--     component's rows. An equality does not. Counts for keys containing `_` or
--     `%` can therefore DROP. That is the repair — the LIST has always grouped
--     these identities exactly, so what the over-match produced was detail and
--     trend inflating against the list they are supposed to reconcile with.
--
-- Both deltas are pinned, in their real directions, by the equivalence cases in
-- packages/database/__tests__/integration/component-session-usage-normalized-key.integration.test.ts.
--
-- RE-RUN / RECOVERY. This file is a single implicit transaction (the dollar-quoted
-- function bodies put `migrate deploy` on its whole-file fallback), so it either
-- fully applied or fully did not. It carries no `IF NOT EXISTS` / `OR REPLACE`
-- deliberately: if a retry reports SQLSTATE 42701 or 42723, the DDL committed and
-- only Prisma's bookkeeping is behind — that is the `partial_committed_ddl_artifact`
-- case in packages/database/AGENTS.md, and the fix is `migrate resolve --applied`,
-- NOT editing this file to be re-runnable.
--
-- SPLIT ACROSS THREE MIGRATIONS ON PURPOSE. This file is metadata-only DDL
-- (`ADD COLUMN` with a constant default is a catalog change in PostgreSQL 11+,
-- no table rewrite), so the ACCESS EXCLUSIVE lock it takes on this
-- continuously-written ingest table is held for microseconds. The full-table
-- backfill is migration 20260820120100 and the index build is
-- 20260820120200 — putting either here would hold that lock for the length of
-- the rewrite or the build and stall desktop session ingest at production size.

-- AlterTable
ALTER TABLE "agent_component_session_usage"
ADD COLUMN "component_key_normalized" TEXT NOT NULL DEFAULT '';

-- The single definition of the fold. IMMUTABLE so it is usable from an index or
-- a generated expression later; STRICT because `component_key` is NOT NULL and a
-- NULL in would be a bug rather than an empty fold. Lower-then-trim, the order
-- `.toLowerCase().trim()` uses.
CREATE FUNCTION "agent_component_session_usage_normalized_key"("value" TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT btrim(
    lower($1),
    E'\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
  )
$$;

CREATE FUNCTION "set_agent_component_session_usage_normalized_key"()
RETURNS TRIGGER AS $$
BEGIN
  NEW."component_key_normalized" :=
    "agent_component_session_usage_normalized_key"(NEW."component_key");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The UPDATE arm names BOTH columns. `component_key` because the fold has to
-- follow it; `component_key_normalized` because declaring the column in
-- schema.prisma makes it writable on the generated client, so
-- `update({ data: { componentKeyNormalized } })` would otherwise persist an
-- arbitrary fold that no read could ever find and that the index would happily
-- serve. Recomputing from `NEW."component_key"` makes that self-healing.
-- Everything else stays OFF the trigger: the ingest upsert's `DO UPDATE SET`
-- (apps/api/app/agent-sessions/service/component-usage.ts) names neither column,
-- so the hot write path pays for the INSERT arm only. That arm is unconditional —
-- a writer that omits the column, supplies a stale one, or supplies a
-- deliberately wrong one all land on the same fold.
CREATE TRIGGER "agent_component_session_usage_normalized_key_sync"
BEFORE INSERT OR UPDATE OF "component_key", "component_key_normalized"
  ON "agent_component_session_usage"
FOR EACH ROW
EXECUTE FUNCTION "set_agent_component_session_usage_normalized_key"();
