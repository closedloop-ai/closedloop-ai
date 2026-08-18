import "server-only";

import {
  decodeComponentHashKey,
  type TokenTrendPoint,
  type TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import { withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import {
  DEFAULT_TOKEN_TREND_LOOKBACK_DAYS,
  MAX_TOKEN_TREND_USAGE_ROWS,
} from "./analytics-validators";
import {
  resolveContentHashIdentity,
  type UsageContentScope,
  usageContentScopeWhere,
} from "./content-hash-identity";
import {
  componentKeyRollsUpToGeneralPurpose,
  isRolledUpSubagentIdentity,
  isRolledUpSubagentKey,
  ROLLED_UP_SUBAGENT_KEY,
} from "./subagent-identity";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token-trend
// ---------------------------------------------------------------------------

/** Optional query parameters for the token-trend endpoint. */
export type TokenTrendQuery = {
  /** Scope to a specific userId for the personal view. */
  userId?: string;
  /** ISO date string — earliest session to include (inclusive). */
  since?: string;
  /** ISO date string — latest session to include (inclusive). */
  until?: string;
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
 * `since` is honored verbatim — a caller that opts into a wide window is bounded
 * by {@link MAX_TOKEN_TREND_USAGE_ROWS} instead.
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
    artifact: { organizationId },
    ...(query.userId ? { userId: query.userId } : {}),
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
 * several names, `keys` carries every name, so match `componentKey` against all
 * of them (case-insensitively) — otherwise usage attached under an alternate
 * name is dropped from the trend even though the content scope covers it.
 */
function tokenTrendComponentKeyWhere(
  kind: string,
  key: string,
  keys: string[]
) {
  if (!isRolledUpSubagentIdentity(kind, key)) {
    const nameKeys = keys.length > 0 ? keys : [key];
    return {
      OR: nameKeys.map((k) => ({
        componentKey: { equals: k, mode: "insensitive" as const },
      })),
    };
  }
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

/** Query all AgentComponentSessionUsage rows for a (kind, key) + org scope. */
function fetchTokenTrendUsageRows(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  kind: string,
  key: string,
  keys: string[],
  organizationId: string,
  query: TokenTrendQuery,
  window: TokenTrendWindow,
  contentScope: UsageContentScope | null
) {
  return db.agentComponentSessionUsage.findMany({
    where: {
      componentKind: kind,
      ...tokenTrendComponentKeyWhere(kind, key, keys),
      // FEA-4335: for a content-hash key, narrow to exactly the requested content
      // version — shared with the detail read so the chart and the detail totals
      // scope identically (`usageContentScopeWhere`).
      ...usageContentScopeWhere(contentScope),
      session: tokenTrendSessionWhere(organizationId, query, window),
    },
    // FEA-3590: keep the most recent sessions when a hot component exceeds the
    // cap within the defaulted window, mirroring the `sessionStartedAt desc`
    // intent of the other org-scoped usage reads. `id asc` is a stable tiebreak
    // so the retained slice never flickers between requests.
    orderBy: [{ session: { sessionStartedAt: "desc" } }, { id: "asc" }],
    // Bound the fan-out to match the sibling org-scoped usage reads
    // (`fetchDetailOrphanUsage`, `loadChildUsageByPackId`, …, all capped by
    // `MAX_ORG_ORPHAN_USAGE_ROWS`) so a param-less read over a hot component
    // can't materialize the whole usage corpus + nested token arrays.
    take: MAX_TOKEN_TREND_USAGE_ROWS,
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
 * {@link resolveTokenTrendWindow}) and, as a backstop, capped at
 * {@link MAX_TOKEN_TREND_USAGE_ROWS} rows, so a param-less request over a hot
 * component never materializes the whole usage corpus into the API heap.
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
  const decoded = decodeComponentHashKey(slug);
  if (!decoded) {
    return Promise.resolve(null);
  }
  const { kind, fingerprint } = decoded;

  const window = resolveTokenTrendWindow(query);

  return withDb(async (db) => {
    // For a content-hash key, resolve the fingerprint to its name-level key +
    // the content-hash set so the usage read scopes to exactly the content
    // version the detail page shows (two same-named-different-bytes components
    // get distinct trends). A fingerprint that resolves to nothing yields an
    // empty trend, never a wrong component's rows.
    let key = decoded.key ?? "";
    // FEA-4335: every name under which this content is installed. For a content-
    // hash key the same bytes can live under different names, so the usage read
    // must match `componentKey` against ALL of them (not just the primary),
    // mirroring the detail read — otherwise usage attached under an alternate
    // name is dropped from the trend even though the content scope covers it.
    let keys: string[] = key ? [key] : [];
    let contentScope: UsageContentScope | null = null;
    if (fingerprint) {
      const identity = await resolveContentHashIdentity(
        db,
        organizationId,
        kind,
        fingerprint
      );
      if (!identity) {
        return { slug, points: [], models: [] };
      }
      key = identity.key;
      keys = identity.keys;
      contentScope = { fingerprint, contentHashes: identity.contentHashes };
    }

    const rawRows = await fetchTokenTrendUsageRows(
      db,
      kind,
      key,
      keys,
      organizationId,
      query,
      window,
      contentScope
    );
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
    if (usageRows.length === 0) {
      return { slug, points: [], models: [] };
    }
    return buildTrendPoints(usageRows, organizationId, slug);
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
