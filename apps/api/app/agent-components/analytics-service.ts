import "server-only";

import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import { withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import {
  DEFAULT_TOKEN_TREND_LOOKBACK_DAYS,
  MAX_TOKEN_TREND_USAGE_ROWS,
} from "./analytics-validators";
import {
  decodeDetailRouteKey,
  resolveDetailIdentityScope,
  type UsageContentScope,
  usageContentScopeWhere,
} from "./content-hash-identity";
import { detailUsageNameKeys, foldedIdentityKeys } from "./detail-usage-reads";
import {
  componentKeyRollsUpToGeneralPurpose,
  isRolledUpSubagentIdentity,
  isRolledUpSubagentKey,
  ROLLED_UP_SUBAGENT_KEY,
} from "./subagent-identity";
import {
  encodeTokenTrendCursor,
  type TokenTrendCursor,
  tokenTrendCursorWhere,
} from "./token-trend-cursor";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token-trend
// ---------------------------------------------------------------------------

/** Optional query parameters for the token-trend endpoint. */
export type TokenTrendQuery = {
  /** Scope to the sessions this user created, for the personal view. */
  userId?: string;
  /** ISO date string — earliest session to include (inclusive). */
  since?: string;
  /** ISO date string — latest session to include (inclusive). */
  until?: string;
  /** ISS-9851 — resume strictly after the session a prior page ended on. */
  cursor?: TokenTrendCursor;
};

// ---------------------------------------------------------------------------
// Token-trend helpers
// ---------------------------------------------------------------------------

type UsageRow = Awaited<ReturnType<typeof fetchTokenTrendUsageRows>>[number];

/** The resolved `sessionStartedAt` window for a token-trend read. */
type TokenTrendWindow = { since: Date; until?: Date };

/**
 * Resolve the effective `sessionStartedAt` window, always producing a lower
 * bound (FEA-3590). `since`/`until` are optional on the wire and the shipped
 * clients send neither, so an absent `since` is defaulted to
 * {@link DEFAULT_TOKEN_TREND_LOOKBACK_DAYS} before the window's upper bound
 * (`until` when present, else now). This forces a bounded date window so a
 * param-less request over a hot component can't materialize the component's
 * entire usage history + nested token arrays into the API heap. An explicit
 * `since` is honored verbatim — a caller that opts into a wide window is read
 * in {@link MAX_TOKEN_TREND_USAGE_ROWS}-row pages instead (ISS-9851).
 */
function resolveTokenTrendWindow(query: TokenTrendQuery): TokenTrendWindow {
  const until = query.until ? new Date(query.until) : undefined;
  if (query.since) {
    return { since: new Date(query.since), until };
  }
  const anchorMs = until ? until.getTime() : Date.now();
  return {
    since: new Date(anchorMs - DEFAULT_TOKEN_TREND_LOOKBACK_DAYS * MS_PER_DAY),
    until,
  };
}

/** Build the Prisma where clause for token-trend session scoping. */
function tokenTrendSessionWhere(
  organizationId: string,
  query: TokenTrendQuery,
  window: TokenTrendWindow
) {
  return {
    artifact: {
      organizationId,
      ...(query.userId ? { createdById: query.userId } : {}),
    },
    sessionStartedAt: {
      gte: window.since,
      ...(window.until ? { lte: window.until } : {}),
    },
  };
}

/**
 * The `componentKey` clause for a token-trend query.
 *
 * For the rolled-up general-purpose subagent identity the listing collapses
 * every instance-unique `Claude subagent <hex>` row into `general-purpose` at
 * read time (see `./subagent-identity`), so the drill-down must match the same
 * rows — otherwise pre-fix per-instance usage never matches and the chart
 * under-reports (FEA-3052). Prisma has no regex operator, so we over-match with
 * a `startsWith` prefix here and tighten to the exact instance pattern in JS via
 * {@link componentKeyRollsUpToGeneralPurpose}. Every other identity matches its
 * `componentKey` case-insensitively (see below).
 *
 * FEA-3757: the plain match MUST be case-insensitive. The component slug key is
 * lowercased (`normalizeComponentKey`), but the stored
 * `AgentComponentSessionUsage.componentKey` preserves the raw subagent type from
 * the transcript (e.g. `Explore`), which the desktop only lowercases at read
 * time. An exact `{ componentKey: key }` match therefore found ZERO usage rows
 * for a mixed-case subagent type — so the token trend read empty and the agent
 * page showed zero token usage despite constant use. The listing/detail reads
 * already match `componentKey` case-insensitively; this brings the token-trend
 * read into parity.
 *
 * FEA-4335: when a content-hash key resolves to the SAME content installed under
 * several names, `keys` carries every name, so match against all of them —
 * otherwise usage attached under an alternate name is dropped from the trend even
 * though the content scope covers it.
 *
 * ISS-6756: the plain match reads the PERSISTED fold
 * (`componentKeyNormalized`, written by the table's BEFORE INSERT/UPDATE trigger)
 * instead of asking Prisma for `mode: "insensitive"`. That case-insensitivity
 * compiles to `component_key ILIKE $n`, an operator NO btree can serve — not even
 * a `LOWER(component_key)` expression index — so this read, which binds neither
 * `agentComponentId` nor `agentSessionId`, could narrow no further than the
 * same-kind partition of every tenant. An equality on the folded column is served
 * by `agent_component_session_usage_kind_key_norm_idx`. Same identity, same
 * fold (`normalizeComponentKey` is what the trigger mirrors) — an indexable
 * spelling of it.
 */
function tokenTrendComponentKeyWhere(
  kind: string,
  key: string,
  keys: string[]
) {
  if (!isRolledUpSubagentIdentity(kind, key)) {
    // Through the shared derivation, so a name that folds to nothing is DROPPED
    // rather than emitted as `IN ('')` — which would match every row still on
    // the column's `ADD COLUMN … DEFAULT ''` value and fabricate a trend for
    // `subagent::`, a slug `decodeComponentSlug` accepts. An all-empty set
    // yields `IN ()`, i.e. no rows, which is what the `ILIKE ''` this replaces
    // returned.
    return {
      componentKeyNormalized: {
        in: foldedIdentityKeys(detailUsageNameKeys(key, keys)),
      },
    };
  }
  // The rolled-up arm keeps matching the RAW `componentKey`, and therefore keeps
  // scanning. Its second arm is a prefix probe for the instance-unique
  // `Claude subagent <hex>` spelling, not an identity equality, and the default
  // opclass on the folded column would not serve a prefix `LIKE` either. Serving
  // it needs `text_pattern_ops` on
  // `agent_component_session_usage_kind_key_norm_idx`, which is a real option —
  // it serves `=` too, and `componentKeyRollsUpToGeneralPurpose` re-checks the
  // exact pattern in JS so widening the SQL arm cannot change the returned set —
  // but it changes the opclass every other identity's equality uses. Deferred,
  // not missed; see migration 20260820120200 for the same note.
  return {
    OR: [
      { componentKey: ROLLED_UP_SUBAGENT_KEY },
      {
        componentKey: {
          startsWith: "claude subagent ",
          mode: "insensitive" as const,
        },
      },
    ],
  };
}

/** Everything one token-trend read is scoped to. */
type TokenTrendReadScope = {
  kind: string;
  key: string;
  keys: string[];
  organizationId: string;
  query: TokenTrendQuery;
  window: TokenTrendWindow;
  contentScope: UsageContentScope | null;
};

type TokenTrendDb = Parameters<Parameters<typeof withDb>[0]>[0];

/**
 * The ONE predicate every token-trend read asks: the page probe, the boundary
 * session's aggregate, and the past-the-boundary probe. Three reads over one
 * `where` means a page can never disagree with the aggregate that completes it
 * or the probe that decides whether it has a successor.
 */
function tokenTrendUsageWhere(
  scope: TokenTrendReadScope,
  agentSessionId?: string
) {
  const { kind, key, keys, organizationId, query, window, contentScope } =
    scope;
  const contentWhere = usageContentScopeWhere(contentScope);
  const andClauses = [
    ...(contentWhere ? [contentWhere] : []),
    ...(query.cursor ? [tokenTrendCursorWhere(query.cursor)] : []),
  ];
  return {
    componentKind: kind,
    ...tokenTrendComponentKeyWhere(kind, key, keys),
    // FEA-4335: for a content-hash key, narrow to exactly the requested content
    // version — shared with the detail read so the chart and the detail totals
    // scope identically (`usageContentScopeWhere`).
    //
    // ISS-6756: nested under `AND` rather than spread, for the reason
    // `detailOrphanUsageWhere` already nests it (whitlockk, ISS-5363):
    // `usageContentScopeWhere` owns an `OR` key of its own, so spreading it
    // beside a sibling that also owns `OR` REPLACED that sibling. Here the
    // sibling is the identity predicate above, so on every content-hash route
    // the chart silently dropped its key predicate entirely — the divergence
    // the comment above claims to prevent, and an unbounded same-kind read
    // that no key index could have helped.
    //
    // ISS-9851: the keyset predicate owns an `OR` too, and it joins the SAME
    // `AND` array. A second conditional `{ AND: [...] }` spread would replace
    // this one, dropping the content scope on every page after the first.
    ...(andClauses.length > 0 ? { AND: andClauses } : {}),
    // ISS-6887: set only by the boundary-session aggregate below, which
    // re-asks this exact predicate for ONE session so a session sitting
    // astride the row ceiling is summed from all of its rows.
    ...(agentSessionId ? { agentSessionId } : {}),
    session: tokenTrendSessionWhere(organizationId, query, window),
  };
}

/** One page probe: the scope's rows, newest session first, one past the ceiling. */
function fetchTokenTrendUsageRows(
  db: TokenTrendDb,
  scope: TokenTrendReadScope
) {
  return db.agentComponentSessionUsage.findMany({
    where: tokenTrendUsageWhere(scope),
    // FEA-3590: keep the most recent sessions when a hot component exceeds the
    // cap within the defaulted window, mirroring the `sessionStartedAt desc`
    // intent of the other org-scoped usage reads. `id asc` is a stable tiebreak
    // so the retained slice never flickers between requests.
    //
    // ISS-6887: `agentSessionId` sorts BETWEEN them so one session's rows are
    // always CONTIGUOUS in the ordered set. FEA-2990 gave a component one usage
    // row per git branch per session, and `sessionStartedAt` alone leaves two
    // sessions that started in the same instant free to interleave — which would
    // let the `take` below bisect a session that is not the last one, defeating
    // the boundary completion.
    orderBy: [
      { session: { sessionStartedAt: "desc" } },
      { agentSessionId: "asc" },
      { id: "asc" },
    ],
    // Bound the fan-out to match the sibling org-scoped usage reads
    // (`fetchDetailOrphanUsage`, `loadChildUsageByPackId`, …, all capped by
    // `MAX_ORG_ORPHAN_USAGE_ROWS`) so a param-less read over a hot component
    // can't materialize the whole usage corpus + nested token arrays. ISS-9851:
    // it bounds ONE page; `nextCursor` continues past it.
    //
    // ISS-6887: the `+ 1` is a PROBE row, never aggregated. Asking for exactly
    // the ceiling makes "exactly N rows exist" and "more than N rows exist"
    // indistinguishable, so a complete page would claim `truncated`. One extra
    // row is the only way the producer can OBSERVE that there is more rather
    // than infer it from an equality; `loadTokenTrendUsageRows` slices it back
    // off, and reads which session it belongs to before deciding on a cursor.
    take: MAX_TOKEN_TREND_USAGE_ROWS + 1,
    select: {
      agentSessionId: true,
      componentKey: true,
      invocationCount: true,
      errorCount: true,
      session: {
        select: {
          artifactId: true,
          sessionStartedAt: true,
          sessionEndedAt: true,
          artifact: { select: { organizationId: true } },
          tokenUsageByModel: {
            select: {
              model: true,
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          },
          usageRollup: { select: { runtimeMs: true } },
        },
      },
    },
  });
}

/**
 * ISS-6887: read one page of the trend's usage rows so the row ceiling never
 * cuts a session in half.
 *
 * `MAX_TOKEN_TREND_USAGE_ROWS` bounds raw usage rows, but `buildTrendPoints`
 * aggregates those rows BY SESSION (FEA-2990 gave a component one row per git
 * branch per session, and the session's `componentInvocations` is their sum). A
 * bare `take` therefore cuts mid-session whenever the ceiling lands inside a
 * multi-branch session's rows, and that session's point is then emitted as a
 * confident total computed from a partial row set — a wrong number, not a
 * missing one.
 *
 * Rows are ordered so a session's rows are contiguous (see the `orderBy` above),
 * so only the LAST session of a bound page can be astride the ceiling. That one
 * session's partial prefix is replaced by its database-side SUM
 * ({@link aggregateBoundarySession}), which is one row per `componentKey`
 * whatever the session's row count — so no session is ever too large to
 * complete, and none is dropped. Every session older than it is left to the
 * next page: ISS-9851 hands back a cursor naming the boundary session, and the
 * next page starts strictly after it.
 *
 * The cursor is handed back only when something lies past the boundary. The
 * probe row proves that when it belongs to another session; when it is the
 * boundary's own, {@link hasRowsPastCursor} asks — otherwise a window whose
 * LAST session straddles the ceiling would claim `truncated` over a whole
 * population and send every reader on one more, empty request.
 *
 * The page decision reads one row PAST the ceiling and compares with `>`, never
 * `>=` against the ceiling itself: a page that exactly fills the bound is
 * COMPLETE, and treating it as cut would assert `truncated` on a whole
 * population.
 */
async function loadTokenTrendUsageRows(
  db: TokenTrendDb,
  scope: TokenTrendReadScope
): Promise<{ rows: UsageRow[]; page: TokenTrendPageMeta }> {
  const probed = await fetchTokenTrendUsageRows(db, scope);
  if (probed.length <= MAX_TOKEN_TREND_USAGE_ROWS) {
    return { rows: probed, page: COMPLETE_PAGE };
  }
  const rows = probed.slice(0, MAX_TOKEN_TREND_USAGE_ROWS);
  const boundary = rows.at(-1);
  const probe = probed.at(MAX_TOKEN_TREND_USAGE_ROWS);
  if (!(boundary && probe)) {
    // Only an empty slice gets here, and there is nothing to page past. A
    // truncated page with no cursor would end a walk that had more to read.
    return { rows, page: COMPLETE_PAGE };
  }
  const kept = rows.filter(
    (row) => row.agentSessionId !== boundary.agentSessionId
  );
  const boundaryRows = await aggregateBoundarySession(db, scope, boundary);
  const cursor: TokenTrendCursor = {
    sessionStartedAtMs: boundary.session.sessionStartedAt.getTime(),
    agentSessionId: boundary.agentSessionId,
  };
  const older =
    probe.agentSessionId !== boundary.agentSessionId ||
    (await hasRowsPastCursor(db, scope, cursor));
  return {
    rows: [...kept, ...boundaryRows],
    page: older
      ? { truncated: true, nextCursor: encodeTokenTrendCursor(cursor) }
      : COMPLETE_PAGE,
  };
}

/**
 * The boundary session, completed as a SUM rather than re-read row by row:
 * one synthetic usage row per `componentKey`, carrying the session's own
 * fields from the probe row and the counts summed over every row the scope
 * matches for that session. Grouped by key rather than collapsed to one so the
 * rolled-up subagent identity's JS tightening and alias de-dupe
 * (`componentKeyRollsUpToGeneralPurpose`, `dropSupersededSubagentAliasRows`)
 * see the same keys they would on a plain page.
 */
async function aggregateBoundarySession(
  db: TokenTrendDb,
  scope: TokenTrendReadScope,
  boundary: UsageRow
): Promise<UsageRow[]> {
  const groups = await db.agentComponentSessionUsage.groupBy({
    by: ["componentKey"],
    where: tokenTrendUsageWhere(scope, boundary.agentSessionId),
    _sum: { invocationCount: true, errorCount: true },
  });
  return groups.map((group) => ({
    agentSessionId: boundary.agentSessionId,
    componentKey: group.componentKey,
    invocationCount: group._sum.invocationCount ?? 0,
    errorCount: group._sum.errorCount ?? 0,
    session: boundary.session,
  }));
}

/** Whether the NEXT page, resumed at `cursor`, would hold anything at all. */
async function hasRowsPastCursor(
  db: TokenTrendDb,
  scope: TokenTrendReadScope,
  cursor: TokenTrendCursor
): Promise<boolean> {
  const row = await db.agentComponentSessionUsage.findFirst({
    where: tokenTrendUsageWhere({
      ...scope,
      query: { ...scope.query, cursor },
    }),
    select: { id: true },
  });
  return row !== null;
}

/**
 * De-dupe the rolled-up subagent alias set per session. A session first synced
 * by a pre-rollup desktop (one instance-unique `Claude subagent <hex>` row per
 * spawn) and later re-synced by a desktop that emits the authoritative
 * `general-purpose` rollup keeps BOTH rows: `persistSessionComponentUsage` only
 * prunes branch buckets within the exact `componentKey`, so the stale alias rows
 * survive under a different key. Since {@link buildTrendPoints} sums a session's
 * invocation/error counts across every matched row, those coexisting aliases
 * would double-count the session's subagent usage. When a session carries the
 * literal `general-purpose` row it is authoritative — drop that session's
 * instance-alias rows. Sessions with only alias rows (never re-synced) are
 * untouched, so their pre-rollup usage still surfaces.
 */
function dropSupersededSubagentAliasRows(rows: UsageRow[]): UsageRow[] {
  const sessionsWithRollup = new Set<string>();
  for (const row of rows) {
    if (isRolledUpSubagentKey(row.componentKey)) {
      sessionsWithRollup.add(row.session.artifactId);
    }
  }
  if (sessionsWithRollup.size === 0) {
    return rows;
  }
  return rows.filter(
    (row) =>
      isRolledUpSubagentKey(row.componentKey) ||
      !sessionsWithRollup.has(row.session.artifactId)
  );
}

/** Derive latency in ms from a usage row's session fields. */
function deriveRuntimeMs(session: UsageRow["session"]): number | null {
  if (session.usageRollup?.runtimeMs != null) {
    return toNumber(session.usageRollup.runtimeMs);
  }
  if (session.sessionEndedAt) {
    return (
      session.sessionEndedAt.getTime() - session.sessionStartedAt.getTime()
    );
  }
  return null;
}

/** Build TokenTrendPoints from usage rows, filtering to the org. */
function buildTrendPoints(
  usageRows: UsageRow[],
  organizationId: string,
  slug: string
): TokenTrendResponse {
  // Decorate each point with a numeric `startedMs` so the sort compares plain
  // numbers instead of re-parsing the ISO `sessionStartedAt` string on every
  // comparison (N vs. ~2·N·log₂N `new Date(...)` calls). The session start Date
  // is already in hand here, so `getTime()` is free.
  const decorated: Array<{ startedMs: number; point: TokenTrendPoint }> = [];
  const modelSet = new Set<string>();

  // FEA-2990: a component can now have several usage rows for one session (one
  // per git_branch). Token/runtime aggregates are session-level, so collapse the
  // per-branch rows to one entry per session first — summing the component's
  // invocation/error counts across branches — otherwise the session's token
  // points would be emitted once per branch and double-counted. Single-branch /
  // legacy sessions (one usage row) are unaffected.
  const usageBySession = new Map<string, UsageRow>();
  for (const usage of usageRows) {
    if (usage.session.artifact?.organizationId !== organizationId) {
      continue;
    }
    const existing = usageBySession.get(usage.session.artifactId);
    if (existing) {
      existing.invocationCount += usage.invocationCount;
      existing.errorCount += usage.errorCount;
    } else {
      // Clone the counts so summing into them never mutates the source row.
      usageBySession.set(usage.session.artifactId, {
        ...usage,
        invocationCount: usage.invocationCount,
        errorCount: usage.errorCount,
      });
    }
  }

  for (const usage of usageBySession.values()) {
    const runtimeMs = deriveRuntimeMs(usage.session);
    const startedMs = usage.session.sessionStartedAt.getTime();
    const sessionStartedAt = usage.session.sessionStartedAt.toISOString();
    for (const tokenRow of usage.session.tokenUsageByModel) {
      modelSet.add(tokenRow.model);
      decorated.push({
        startedMs,
        point: {
          sessionId: usage.session.artifactId,
          sessionStartedAt,
          model: tokenRow.model,
          inputTokens: toNumber(tokenRow.inputTokens),
          outputTokens: toNumber(tokenRow.outputTokens),
          cacheReadTokens: toNumber(tokenRow.cacheReadTokens),
          cacheWriteTokens: toNumber(tokenRow.cacheWriteTokens),
          estimatedCostUsd: toNumber(tokenRow.estimatedCost),
          runtimeMs,
          componentInvocations: usage.invocationCount,
          componentErrorCount: usage.errorCount,
        },
      });
    }
  }

  decorated.sort((a, b) => a.startedMs - b.startedMs);
  const points = decorated.map((entry) => entry.point);

  return { slug, points, models: [...modelSet].sort() };
}

// ---------------------------------------------------------------------------
// Token-trend public function
// ---------------------------------------------------------------------------

/**
 * Fetch per-(component, model) token/cost/latency/truncation time series.
 *
 * Join path:
 *   `AgentComponentSessionUsage` (filtered by componentKind + componentKey)
 *   → `SessionDetail` (org-scoped through `Artifact.organizationId`)
 *   → `AgentSessionTokenUsage` (per-model token/cost aggregates)
 *   → `AgentSessionUsageRollup` (for `runtimeMs` latency proxy)
 *
 * Returns one `TokenTrendPoint` per (session × model) pair, ordered ascending
 * by `sessionStartedAt`. An empty `points` array is returned when the
 * component slug is valid but has no matching usage rows.
 *
 * FEA-3590: when the caller supplies no `since`, the read is bounded to a
 * default {@link DEFAULT_TOKEN_TREND_LOOKBACK_DAYS}-day lookback window (see
 * {@link resolveTokenTrendWindow}), and one request reads at most
 * {@link MAX_TOKEN_TREND_USAGE_ROWS} rows, so a param-less request over a hot
 * component never materializes the whole usage corpus into the API heap.
 * ISS-9851: a response that stopped at that bound carries `nextCursor`, and the
 * caller passes it back as `cursor` to read the rest of the window.
 *
 * Returns `null` when the slug cannot be parsed (invalid format).
 */
function fetchTokenTrend(
  organizationId: string,
  slug: string,
  query: TokenTrendQuery
): Promise<TokenTrendResponse | null> {
  // FEA-4335: the slug is the content-hash routable key (`${kind}::${fingerprint}`)
  // for a new link, or the legacy name-level `${kind}::${key}` for old links.
  // ISS-10815 adds the name-qualified id the list emits; all three decode here.
  const decoded = decodeDetailRouteKey(slug);
  if (!decoded) {
    return Promise.resolve(null);
  }
  const { kind, fingerprint } = decoded;

  const window = resolveTokenTrendWindow(query);

  return withDb(async (db) => {
    // For a content-hash key, resolve the fingerprint to its name-level key +
    // the content-hash set. A fingerprint that resolves to nothing yields an
    // empty trend, never a wrong component's rows.
    //
    // ISS-10815 changed WHICH RESOLVER runs, not what this read then scopes by:
    // `resolveDetailIdentityScope`, the same helper the detail read uses, rather
    // than a lone `resolveContentHashIdentity` call. That was the drift this
    // module's header says must not happen, and it became visible rather than
    // theoretical once the detail learned to resolve a usage-only representative
    // fingerprint — the card would state a named family with N sessions while
    // this chart, still resolving only version rows, returned the empty series
    // that means "no usage at all". On THAT rung the two halves now agree,
    // because the scope it returns carries no content narrow.
    //
    // A fingerprint that DOES resolve version or inventory rows still narrows
    // this read to that byte-version, exactly as before, while the card beside it
    // sums the family (ISS-10341 passes `contentScope: null`). That disagreement
    // predates this change and is untouched by it: widening the chart to the
    // family is the explicit drill-down question ISS-10467/ISS-10468 own, not a
    // resolver detail to settle here.
    let key = decoded.key ?? "";
    // FEA-4335: every name under which this content is installed. For a content-
    // hash key the same bytes can live under different names, so the usage read
    // must match `componentKey` against ALL of them (not just the primary),
    // mirroring the detail read — otherwise usage attached under an alternate
    // name is dropped from the trend even though the content scope covers it.
    let keys: string[] = key ? [key] : [];
    let contentScope: UsageContentScope | null = null;
    if (fingerprint) {
      const scope = await resolveDetailIdentityScope(
        db,
        organizationId,
        kind,
        fingerprint,
        decoded.key
      );
      // A used-only identity the fingerprint alone names: the detail builds that
      // page from the orphan lanes, which this keyed read does not cover, so the
      // honest answer stays the empty series it has always been here.
      if (scope.orphanOnly) {
        return withTrendMetadata({ slug, points: [], models: [] }, window);
      }
      key = scope.key;
      keys = scope.keys;
      contentScope = scope.usageContentScope;
    }

    const { rows: rawRows, page } = await loadTokenTrendUsageRows(db, {
      kind,
      key,
      keys,
      organizationId,
      query,
      window,
      contentScope,
    });
    // For the rolled-up general-purpose subagent identity the query over-matches
    // with a `startsWith` prefix (Prisma has no regex); tighten here to the exact
    // instance pattern so the drill-down's row set equals the set the listing
    // rolls up — no `Claude subagent <non-hex>` false positive slips in — then
    // drop stale alias rows for any session that also carries the authoritative
    // `general-purpose` rollup so a re-synced session is not double-counted.
    const usageRows = isRolledUpSubagentIdentity(kind, key)
      ? dropSupersededSubagentAliasRows(
          rawRows.filter((row) =>
            componentKeyRollsUpToGeneralPurpose(row.componentKey)
          )
        )
      : rawRows;
    // One return, so the page's cursor survives a page the JS filter above
    // emptied: the rolled-up identity can read a full page and keep none of it
    // while older sessions still exist.
    return withTrendMetadata(
      buildTrendPoints(usageRows, organizationId, slug),
      window,
      page
    );
  });
}

// ---------------------------------------------------------------------------
// Exported service
// ---------------------------------------------------------------------------

export const analyticsService = {
  /**
   * Per-(component, model) token/cost/latency/truncation time series.
   * See `fetchTokenTrend` for full documentation.
   */
  fetchTokenTrend,
};

/**
 * ISS-6887: attach the read's own honesty metadata to every return path.
 *
 * `appliedWindow` names the `sessionStartedAt` bounds the read actually used —
 * the shipped clients send no `since`/`until`, so without it a defaulted
 * 90-day slice is indistinguishable on the wire from a component's whole
 * history. `truncated` is carried in from the read whose `take` bound, never
 * re-derived from `points.length` (points are session × model pairs, so their
 * count has no fixed relation to the row ceiling), and is OMITTED rather than
 * emitted as `false` so a reader that predates the field sees today's shape.
 * ISS-9851's `nextCursor` follows the same rule.
 */
function withTrendMetadata(
  response: TokenTrendResponse,
  window: TokenTrendWindow,
  page: TokenTrendPageMeta = COMPLETE_PAGE
): TokenTrendResponse {
  return {
    ...response,
    appliedWindow: {
      since: window.since.toISOString(),
      ...(window.until ? { until: window.until.toISOString() } : {}),
    },
    ...(page.truncated ? { truncated: true } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * ISS-9851: what one page of the read reports about itself. `truncated` keeps
 * its ISS-6887 meaning — this response ends before the window does — and a
 * page that sets it names where the next page starts.
 */
type TokenTrendPageMeta = {
  truncated: boolean;
  nextCursor?: string;
};

const COMPLETE_PAGE: TokenTrendPageMeta = { truncated: false };
