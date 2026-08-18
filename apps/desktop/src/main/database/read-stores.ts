import type {
  AgentHierarchyNode,
  AgentRow,
  EventCountByType,
  EventRow,
  EventWithSession,
  KanbanPages,
  SessionPage,
  SessionPageRequest,
  SessionRow,
  SessionWithAgents,
} from "../../shared/agent-db-contract.js";
import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import type {
  TokenUsageCounts,
  TokenUsageRow,
} from "../dashboard/agent-dashboard-db-types.js";
import { CodexOtelTokenUsageSource } from "../otel/codex-otel-contract.js";
import {
  DEFAULT_SESSION_PAGE_LIMIT,
  DESKTOP_AGENT_STATUS,
  MAX_SESSION_PAGE_LIMIT,
  TERMINAL_STATUS_SET,
  TERMINAL_STATUSES,
} from "./db-constants.js";
import {
  escapeSqliteLikePattern,
  normalizeTokenUsageCounts,
  tokenCountValue,
} from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { countSqliteSessions } from "./session-count.js";
import {
  detailRowsToList,
  sessionDetailsCtes,
  toTokenUsageRow,
} from "./session-detail-mappers.js";
import { attachEstimatedCosts } from "./session-estimated-costs.js";

// Explicit column projection for session list/detail reads. Lists ONLY the
// columns `toSessionRow` (and `detailRowsToList`) actually consume, so the
// large unused `sessions` columns — `metadata` is read and therefore kept, but
// the JSONB `trace_phase_sources` / `throttle_sources` / `correction_sources`
// and the `cost_*` / `data_revision` columns are NOT materialized on every
// listed row. Behavior-preserving: identical mapped `SessionRow` output, fewer
// bytes read. `attachEstimatedCosts` re-queries `cost_usd_estimated` on its own,
// so dropping it here is safe.
const SESSION_ROW_COLUMNS = [
  "id",
  "name",
  "status",
  "cwd",
  "model",
  "started_at",
  "updated_at",
  "ended_at",
  "awaiting_input_since",
  "metadata",
  "harness",
  "billing_mode",
  "user_id",
  "organization_id",
] as const;

// `s.`-aliased column list for the detail CTE queries that join aggregate
// counts onto `sessions s` (replaces the prior `s.*`).
const SESSION_DETAIL_SELECT_COLUMNS = SESSION_ROW_COLUMNS.map(
  (column) => `s.${column}`
).join(", ");

// Columns that make up a SessionRow, projected explicitly (matches
// SESSION_ROW_COLUMNS) so the typed reads return exactly the SessionRow shape and
// no later schema column leaks through.
const SESSION_ROW_SELECT = {
  id: true,
  name: true,
  status: true,
  cwd: true,
  model: true,
  startedAt: true,
  updatedAt: true,
  endedAt: true,
  awaitingInputSince: true,
  metadata: true,
  harness: true,
  billingMode: true,
  userId: true,
  organizationId: true,
} satisfies Prisma.SessionSelect;

// The plain reads (getById/getAll/getActive) are typed delegates. The DETAIL
// reads (getDetailsById/getActiveWithDetails/getHistoricalWithDetails/getPage)
// stay on raw `$queryRawUnsafe` BY DESIGN — sessionDetailsCtes() folds the
// per-session COUNT(agents)/COUNT(events)/SUM(tokens) into the row in ONE
// server-side aggregate-join. That is both un-typeable (events/token_usage have
// no session relation; total_tokens is a SUM, not a relation `_count`) and the
// performant choice: replacing it with per-table groupBy reads marshalled into a
// JS join is a real regression. getPage's `q` search additionally needs
// `LIKE … ESCAPE` (Prisma `contains` does not escape `%`/`_`, verified against
// libSQL). The raw `selectRowsByIds`/`selectTokenUsageRows` helpers serve the
// tx-coupled sync/importer/analytics paths.
//
// ISS-6199 (following ISS-5938 for the Insights/dashboard reads): every read in
// this module that serves a renderer read channel dispatches through
// `prisma.read` onto the READER POOL, one dispatch per aggregate, so it no
// longer self-serializes on the PRIMARY connection or contends with first-launch
// backfill and live-import writes. Raw SQL is fully available there —
// `DesktopPrismaReader` re-exposes `$queryRaw`/`$queryRawUnsafe` — so "this SQL
// must stay raw" was never a reason for it to stay on the writer. Exactly two
// reads deliberately STAY on `prisma.client`, and the seam is pinned in both
// directions by `test/session-read-stores-reader-pool.test.ts`:
//   - `handleSessionMutation`'s own status read, issued right after a committed
//     write to decide historical-cache invalidation — a genuine read-your-writes
//     read that must see the writer's own snapshot. It reads the status directly
//     rather than through `getById` so that requirement stays where it belongs:
//     `getById` also serves the `desktop:db:get-session` renderer channel, which
//     has no such requirement and would otherwise keep the contention this
//     change removes.
//   - the events `getCountByType` model-delegate `groupBy`. FEA-2211 (see
//     session-count.ts) documents that a Prisma AGGREGATE delegate returns 0 on
//     the `query_only` reader connections in PACKAGED builds while behaving
//     correctly in the clean test env, so moving it to the pool would pass every
//     test and zero the renderer in production. The documented quirk is specific
//     to AGGREGATE delegates, and row-returning `findMany` reads are already used
//     on the pool by five sibling stores — but that is precedent, not a proof:
//     `dashboard-queries.ts` deliberately keeps its take-10 `findMany` on the
//     writer too, folded into the same bucket as its aggregates rather than
//     separated from them. Move a row read to the pool on that precedent
//     knowingly; there is no test that can catch the packaged-build behavior.
export function createSqliteSessionStore(prisma: DesktopPrisma) {
  let historicalDetailsCache: SessionWithAgents[] | null = null;
  // Bumped by every invalidation. `getHistoricalWithDetails` awaits three pooled
  // reads, and the invalidation that clears the cache is detached from them (the
  // db-host worker does not await `handleSessionMutation`), so the generation is
  // what tells an in-flight read that its rows were retired while it ran.
  let historicalDetailsGeneration = 0;

  return {
    async getById(id: string): Promise<SessionRow | undefined> {
      const rows = await prisma.read((reader) =>
        reader.session.findMany({
          where: { id },
          select: SESSION_ROW_SELECT,
          take: 1,
        })
      );
      return rows[0];
    },
    /**
     * Total number of rows in `sessions`. Runs on the reader pool (NOT the
     * writer-bound `prisma.client`) so the perf-cliff `session_count` dimension
     * never contends with first-launch backfill writes; the same raw `COUNT(*)`
     * the Sessions-list pagination total uses (FEA-2211). Exposed as a clone-safe
     * method (no callback args, plain-number result) so it can be invoked across
     * the FEA-2038 db-host process boundary, where a `prisma.read(callback)`
     * issued from the main process cannot cross IPC (DataCloneError).
     */
    count(): Promise<number> {
      return prisma.read((reader) => countSqliteSessions(reader));
    },
    async getAll(): Promise<SessionRow[]> {
      return await prisma.read((reader) =>
        reader.session.findMany({
          select: SESSION_ROW_SELECT,
          orderBy: { startedAt: "desc" },
        })
      );
    },
    async getActive(): Promise<SessionRow[]> {
      return await prisma.read((reader) =>
        reader.session.findMany({
          where: { status: { notIn: Array.from(TERMINAL_STATUS_SET) } },
          select: SESSION_ROW_SELECT,
          orderBy: { startedAt: "desc" },
        })
      );
    },
    async getDetailsById(id: string): Promise<SessionWithAgents | undefined> {
      // Single server-side aggregate-join (sessionDetailsCtes): per-session
      // COUNT(agents) / COUNT(events) / SUM(tokens) LEFT-JOINed to the row in ONE
      // query. Stays RAW deliberately — Prisma can't express it typed
      // (events/token_usage have no session relation; total_tokens is a SUM, not
      // a relation `_count`), and, more importantly, it is far cheaper than
      // fetching every session's per-table aggregate and joining in JS. Raw and
      // pooled are independent choices: the reader facade re-exposes
      // `$queryRawUnsafe`, so this runs on the pool (ISS-6199).
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<Record<string, unknown>[]>(
          `${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        WHERE s.id = $1
      `,
          id
        )
      );
      const sessions = detailRowsToList(rows);
      await attachEstimatedCosts(prisma, sessions);
      return sessions[0];
    },
    async getActiveWithDetails(): Promise<SessionWithAgents[]> {
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<
          Record<string, unknown>[]
        >(`${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        WHERE s.status NOT IN ${TERMINAL_STATUSES}
        ORDER BY s.started_at DESC
      `)
      );
      const sessions = detailRowsToList(rows);
      await attachEstimatedCosts(prisma, sessions);
      return sessions;
    },
    async getHistoricalWithDetails(): Promise<SessionWithAgents[]> {
      if (historicalDetailsCache) {
        return historicalDetailsCache;
      }
      const generation = historicalDetailsGeneration;
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<
          Record<string, unknown>[]
        >(`${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        WHERE s.status IN ${TERMINAL_STATUSES}
        ORDER BY s.started_at DESC
      `)
      );
      const sessions = detailRowsToList(rows);
      await attachEstimatedCosts(prisma, sessions);
      // Publish only if nothing invalidated while those reads were in flight:
      // these rows come from a snapshot taken before that mutation committed, so
      // caching them would re-serve known-stale data until the next mutation.
      // The caller still gets the rows it read — returning the memo field here
      // would hand back `null` from a method typed to return an array.
      if (historicalDetailsGeneration === generation) {
        historicalDetailsCache = sessions;
      }
      return sessions;
    },
    async getAllWithDetails(): Promise<SessionWithAgents[]> {
      return [
        ...(await this.getActiveWithDetails()),
        ...(await this.getHistoricalWithDetails()),
      ];
    },
    async getPage(request?: SessionPageRequest): Promise<SessionPage> {
      // Same single aggregate-join as the other detail reads, with the dynamic
      // status/search WHERE + LIMIT/OFFSET. Raw: the per-session COUNT/SUM join
      // is cheaper than per-table groupBy + JS, and the `q` search needs
      // `LIKE … ESCAPE` (Prisma `contains` does not escape `%`/`_`).
      const { limit, offset, status, q } = coercePageRequest(request);
      const { whereSql, params } = pageWhereClause(status, q);
      // SSOT count helper (FEA-2211) — same SQL and `Number(... ?? 0)` coercion
      // as the inline query it replaced, shared with the IPC perf `session_count`
      // dimension so the two never diverge. Its own contract puts it on the
      // reader pool (ISS-6199), which is also where the `session_count` dimension
      // and the sync-source cursor page already call it from.
      const total = await prisma.read((reader) =>
        countSqliteSessions(reader, whereSql, params)
      );
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<Record<string, unknown>[]>(
          `${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        ${whereSql}
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
          ...params,
          limit,
          offset
        )
      );
      const sessions = detailRowsToList(rows);
      // FEA-1459 Fix 10: Compute estimated cost per session from token_usage.
      await attachEstimatedCosts(prisma, sessions);
      return {
        sessions,
        total,
        limit,
        offset,
      };
    },
    async getKanbanPages(
      statuses: string[],
      limit: number
    ): Promise<KanbanPages> {
      const result: KanbanPages = {};
      for (const status of statuses) {
        result[status] = await this.getPage({ limit, status });
      }
      return result;
    },
    invalidateHistoricalDetails(): void {
      historicalDetailsCache = null;
      historicalDetailsGeneration += 1;
    },
    async handleSessionMutation(sessionId: string): Promise<void> {
      // The ONE read-your-writes read in this store: it runs immediately after
      // the write that emitted this mutation, so it must see the writer's own
      // snapshot rather than a pooled one (ISS-6199 — see the module note). Only
      // the status decides the invalidation, so it reads just that column instead
      // of routing through the now-pooled `getById`.
      const session = await prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!session || TERMINAL_STATUS_SET.has(session.status)) {
        // Delegate rather than re-clear inline: a second copy of the memo/
        // generation pair is a copy that can lose the generation bump while the
        // tests that drive `invalidateHistoricalDetails` directly stay green.
        this.invalidateHistoricalDetails();
      }
    },
  };
}

function coercePageRequest(request: SessionPageRequest | undefined): {
  limit: number;
  offset: number;
  status: string | null;
  q: string | null;
} {
  const requestedLimit = request?.limit;
  const limit =
    typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_SESSION_PAGE_LIMIT)
      : DEFAULT_SESSION_PAGE_LIMIT;
  const requestedOffset = request?.offset;
  const offset =
    typeof requestedOffset === "number" && Number.isInteger(requestedOffset)
      ? Math.max(requestedOffset, 0)
      : 0;
  const status =
    typeof request?.status === "string" && request.status.length > 0
      ? request.status
      : null;
  const q =
    typeof request?.q === "string" && request.q.trim().length > 0
      ? request.q.trim()
      : null;
  return { limit, offset, status, q };
}

function pageWhereClause(
  status: string | null,
  q: string | null
): {
  whereSql: string;
  params: unknown[];
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (status === DESKTOP_AGENT_STATUS.WAITING) {
    // The `s.ended_at IS NULL` guard mirrors the cloud facet/projection
    // (FEA-3149): an ended row must not surface as Waiting even if its status is
    // not yet canonicalized to a terminal value.
    where.push(
      `s.status NOT IN ${TERMINAL_STATUSES} AND s.awaiting_input_since IS NOT NULL AND s.ended_at IS NULL`
    );
  } else if (status === DESKTOP_AGENT_STATUS.RUNNING) {
    where.push(
      `s.status NOT IN ${TERMINAL_STATUSES} AND s.awaiting_input_since IS NULL`
    );
  } else if (status && status !== "all") {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  if (q) {
    const escaped = escapeSqliteLikePattern(q);
    const like = `%${escaped}%`;
    const start = params.length + 1;
    params.push(like, like, like, like);
    where.push(
      `(s.id LIKE $${start} ESCAPE '\\' OR s.name LIKE $${start + 1} ESCAPE '\\' OR s.cwd LIKE $${start + 2} ESCAPE '\\' OR s.model LIKE $${start + 3} ESCAPE '\\')`
    );
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

// Columns that make up an AgentRow, projected explicitly so the typed reads
// return exactly the AgentRow shape.
const AGENT_ROW_SELECT = {
  id: true,
  sessionId: true,
  name: true,
  type: true,
  subagentType: true,
  status: true,
  task: true,
  currentTool: true,
  startedAt: true,
  updatedAt: true,
  endedAt: true,
  awaitingInputSince: true,
  parentAgentId: true,
  metadata: true,
} satisfies Prisma.AgentSelect;

// Both agent reads run on typed Prisma delegates, dispatched onto the reader
// pool (ISS-6199 — see the module note on createSqliteSessionStore).
// getBySessionWithChildren builds its parent/child tree in memory from
// parentAgentId.
export function createSqliteAgentStore(
  prisma: DesktopPrisma,
  eventStore: ReturnType<typeof createSqliteEventStore>
) {
  return {
    async getBySession(sessionId: string): Promise<AgentRow[]> {
      return await prisma.read((reader) =>
        reader.agent.findMany({
          where: { sessionId },
          select: AGENT_ROW_SELECT,
          orderBy: { startedAt: "asc" },
        })
      );
    },
    async getBySessionWithChildren(
      sessionId: string
    ): Promise<AgentHierarchyNode[]> {
      const allAgents = await prisma.read((reader) =>
        reader.agent.findMany({
          where: { sessionId },
          select: AGENT_ROW_SELECT,
          orderBy: { startedAt: "asc" },
        })
      );
      const eventsByAgent = new Map<string, AgentHierarchyNode["events"]>();
      for (const e of await eventStore.getBySession(sessionId)) {
        if (!e.agentId) {
          continue;
        }
        const list = eventsByAgent.get(e.agentId) ?? [];
        list.push({
          eventType: e.eventType,
          toolName: e.toolName,
          summary: e.summary,
          createdAt: e.createdAt,
        });
        eventsByAgent.set(e.agentId, list);
      }

      const agentMap = new Map<string, AgentHierarchyNode>();
      const roots: AgentHierarchyNode[] = [];
      for (const agent of allAgents) {
        agentMap.set(agent.id, {
          agentId: agent.id,
          name: agent.name,
          type: agent.type,
          subagentType: agent.subagentType,
          status: agent.status,
          task: agent.task,
          currentTool: agent.currentTool,
          children: [],
          events: eventsByAgent.get(agent.id) ?? [],
        });
      }
      for (const agent of allAgents) {
        const node = agentMap.get(agent.id)!;
        if (agent.parentAgentId && agentMap.has(agent.parentAgentId)) {
          agentMap.get(agent.parentAgentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
      return roots;
    },
  };
}

// The events columns that make up an EventRow, projected explicitly so a future
// schema column never silently leaks into the IPC payload via `...row`.
const EVENT_ROW_SELECT = {
  id: true,
  sessionId: true,
  agentId: true,
  eventType: true,
  toolName: true,
  summary: true,
  data: true,
  createdAt: true,
} satisfies Prisma.EventSelect;

// The events store is read-only, so all five reads run on typed Prisma
// delegates. `events.session_id` has no FK/relation to `sessions` (events may
// arrive before their session row — see the Event model in schema.prisma), so
// the two session-name reads cannot use a relation `include`; both resolve the
// name through `sessionNamesById` below, matching LEFT JOIN semantics (name is
// null when the session row is absent).
export function createSqliteEventStore(prisma: DesktopPrisma) {
  return {
    async getBySession(sessionId: string): Promise<EventRow[]> {
      return await prisma.read((reader) =>
        reader.event.findMany({
          where: { sessionId },
          select: EVENT_ROW_SELECT,
          orderBy: { createdAt: "asc" },
        })
      );
    },
    async getBySessionAndAgent(
      sessionId: string,
      agentId: string
    ): Promise<EventRow[]> {
      return await prisma.read((reader) =>
        reader.event.findMany({
          where: { sessionId, agentId },
          select: EVENT_ROW_SELECT,
          orderBy: { createdAt: "asc" },
        })
      );
    },
    async getAll(): Promise<EventWithSession[]> {
      const rows = await prisma.read((reader) =>
        reader.event.findMany({
          select: EVENT_ROW_SELECT,
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      );
      const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
      // Dependent on `rows`, so it stays a second dispatch rather than joining
      // the one above under a Promise.all.
      const nameById = await sessionNamesById(prisma, sessionIds);
      return rows.map((row) => ({
        ...row,
        sessionName: nameById.get(row.sessionId) ?? null,
      }));
    },
    async getWithSession(sessionId: string): Promise<EventWithSession[]> {
      const rows = await prisma.read((reader) =>
        reader.event.findMany({
          where: { sessionId },
          select: EVENT_ROW_SELECT,
          orderBy: { createdAt: "asc" },
        })
      );
      // No events -> no rows to decorate; skip the session-name lookup, keeping
      // the empty case a single query (mirrors the guard in getAll()).
      if (rows.length === 0) {
        return [];
      }
      const sessionName =
        (await sessionNamesById(prisma, [sessionId])).get(sessionId) ?? null;
      return rows.map((row) => ({ ...row, sessionName }));
    },
    async getCountByType(): Promise<EventCountByType[]> {
      // event_type is NOT NULL, so _count.eventType per group equals COUNT(*),
      // and ordering by it reproduces the raw `ORDER BY count DESC`.
      //
      // ISS-6199: this is the one read in the events store that must STAY on
      // `prisma.client`. It is a model-delegate AGGREGATE, and FEA-2211 (see
      // session-count.ts) documents that such an aggregate returns 0 on the
      // `query_only` reader connections in PACKAGED builds while returning the
      // true value in the clean test env — so moving it to the pool would pass
      // every test and zero the renderer's event-type breakdown in production.
      // Same rule dashboard-queries.ts records for its own `groupBy`/`count`
      // reads. Route it through the pool only by rewriting it as raw
      // `COUNT(*) … GROUP BY`, which is the proven-safe shape there.
      const grouped = await prisma.client.event.groupBy({
        by: ["eventType"],
        _count: { eventType: true },
        orderBy: { _count: { eventType: "desc" } },
      });
      return grouped.map((row) => ({
        eventType: row.eventType,
        count: row._count.eventType,
      }));
    },
  };
}

/**
 * Resolve `sessions.name` for `ids` on the reader pool, as an id → name map. No
 * entry means the session row is absent, which both callers read as a null name
 * (the LEFT JOIN semantics the missing FK/relation forces them to hand-roll).
 *
 * `findMany` even for the single-id caller, deliberately: it is the only
 * row-read delegate with reader-pool precedent in this store layer, and
 * FEA-2211's caveat (see `session-count.ts`) makes an unprecedented delegate on
 * a `query_only` connection a risk whose failure mode is silent and
 * packaged-build-only — here, every `sessionName` quietly becoming null.
 */
async function sessionNamesById(
  prisma: DesktopPrisma,
  ids: readonly string[]
): Promise<Map<string, string | null>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await prisma.read((reader) =>
    reader.session.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    })
  );
  return new Map(rows.map((row) => [row.id, row.name ?? null]));
}

// `getBySession` is a typed delegate on the reader pool (ISS-6199); `replace`
// runs on the writer and uses a hand-written `INSERT ... ON CONFLICT DO UPDATE` as
// RAW `$executeRawUnsafe` (not expressible via Prisma `upsert`: the update branch
// accumulates baselines `baseline_x = token_usage.x + EXCLUDED.x`, heals
// `created_at` downward via `MIN(...)`, and carries a conflict-target
// `WHERE usage_source != $15` guard). It takes an optional
// `Prisma.TransactionClient` so the importer / lifecycle / sync paths run it
// inside their `$transaction`; called standalone it wraps the existing-row read +
// the upsert in its own atomic `prisma.write($transaction)`.
export function createSqliteTokenUsageStore(prisma: DesktopPrisma) {
  return {
    async replace(
      sessionId: string,
      model: string,
      counts: TokenUsageCounts,
      now: string,
      tx?: Prisma.TransactionClient,
      /** FEA-1459 Fix 5: Explicit activity timestamp for created_at. */
      activityTs?: string
    ): Promise<void> {
      const storageCounts = normalizeTokenUsageCounts(counts, "token_usage");
      if (
        storageCounts.input === 0 &&
        storageCounts.output === 0 &&
        storageCounts.cacheRead === 0 &&
        storageCounts.cacheWrite === 0
      ) {
        return;
      }
      const createdAt = activityTs ?? now;
      // FEA-1459 (PR #1511 review): plain overwrite, NOT high-water-mark
      // accumulation. Both callers (boot importer + live-hook extractor)
      // re-derive FULL totals from the entire transcript on every call, and
      // Claude transcripts are append-only — so the latest derivation is
      // always authoritative. The old HWM upsert treated a shrinking raw_*
      // as a counter reset and ADDED the new value on top, which corrupted
      // upgraded installs: the v2 deduped (smaller) totals were stacked onto
      // the v1 inflated rows (input = old_inflated + new_deduped).
      // created_at heals downward via LEAST: boot passes the earliest real
      // activity timestamp, which must win over a previously stamped
      // import/hook time; hook calls pass `now`, which never wins.
      //
      // Gap 5 / compaction resilience: before overwriting, read the existing
      // row. If the new per-model totals are LOWER than the stored values, a
      // transcript compaction rewrote history. Roll the old totals into
      // baseline_* columns before applying the new (post-compaction) values so
      // effective_total = baseline + current remains correct. FEA-2879: the
      // pricing/count read sites (selectTokenUsagePricingRows,
      // repriceUnpricedTokenUsageChunk, the session_analytics rollup) fold
      // baseline_* back in, so this preservation is now actually honored
      // downstream rather than written and dropped.
      const run = async (itx: Prisma.TransactionClient): Promise<void> => {
        const existingRow = await itx.tokenUsage.findUnique({
          where: { sessionId_model: { sessionId, model } },
          select: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
          },
        });
        const existingCounts = existingRow
          ? {
              input: tokenCountValue(
                existingRow.inputTokens,
                "token_usage.input_tokens"
              ),
              output: tokenCountValue(
                existingRow.outputTokens,
                "token_usage.output_tokens"
              ),
              cacheRead: tokenCountValue(
                existingRow.cacheReadTokens,
                "token_usage.cache_read_tokens"
              ),
              cacheWrite: tokenCountValue(
                existingRow.cacheWriteTokens,
                "token_usage.cache_write_tokens"
              ),
            }
          : null;
        const baselineInput =
          existingCounts && storageCounts.input < existingCounts.input
            ? existingCounts.input
            : 0;
        const baselineOutput =
          existingCounts && storageCounts.output < existingCounts.output
            ? existingCounts.output
            : 0;
        const baselineCacheRead =
          existingCounts && storageCounts.cacheRead < existingCounts.cacheRead
            ? existingCounts.cacheRead
            : 0;
        const baselineCacheWrite =
          existingCounts && storageCounts.cacheWrite < existingCounts.cacheWrite
            ? existingCounts.cacheWrite
            : 0;

        await itx.$executeRawUnsafe(
          `
          INSERT INTO token_usage (
            session_id, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            raw_input, raw_output, raw_cache_read, raw_cache_write,
            baseline_input, baseline_output, baseline_cache_read, baseline_cache_write,
            usage_source, revision_id,
            created_at, updated_at, inferred,
            cache_write_5m_tokens, cache_write_1h_tokens
          )
          VALUES ($1, $2, $3, $4, $5, $6, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16, $17, $18)
          ON CONFLICT (session_id, model) DO UPDATE SET
            input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens,
            cache_read_tokens = EXCLUDED.cache_read_tokens,
            cache_write_tokens = EXCLUDED.cache_write_tokens,
            cache_write_5m_tokens = EXCLUDED.cache_write_5m_tokens,
            cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens,
            raw_input = EXCLUDED.raw_input,
            raw_output = EXCLUDED.raw_output,
            raw_cache_read = EXCLUDED.raw_cache_read,
            raw_cache_write = EXCLUDED.raw_cache_write,
            baseline_input = token_usage.baseline_input + EXCLUDED.baseline_input,
            baseline_output = token_usage.baseline_output + EXCLUDED.baseline_output,
            baseline_cache_read = token_usage.baseline_cache_read + EXCLUDED.baseline_cache_read,
            baseline_cache_write = token_usage.baseline_cache_write + EXCLUDED.baseline_cache_write,
            usage_source = EXCLUDED.usage_source,
            revision_id = EXCLUDED.revision_id,
            created_at = MIN(token_usage.created_at, EXCLUDED.created_at),
            updated_at = EXCLUDED.updated_at,
            inferred = EXCLUDED.inferred
          WHERE token_usage.usage_source != $15
        `,
          sessionId,
          model,
          storageCounts.input,
          storageCounts.output,
          storageCounts.cacheRead,
          storageCounts.cacheWrite,
          baselineInput,
          baselineOutput,
          baselineCacheRead,
          baselineCacheWrite,
          CodexOtelTokenUsageSource.JsonlParser,
          DATA_REVISION,
          createdAt,
          now,
          CodexOtelTokenUsageSource.OtelLogPayload,
          // FEA-2085: stamp guessed Codex attributions (SQLite boolean → 0/1).
          counts.inferred ? 1 : 0,
          // FEA-3419: TTL subdivision — plain overwrite like the four counters
          // (every caller re-derives full totals from the whole transcript, so
          // the latest derivation is authoritative, including NULL = absent).
          // Baselines deliberately carry NO TTL: compaction-rolled tokens have
          // no per-request data and price at the default rate (unclassified).
          storageCounts.cacheWriteTtl
            ? storageCounts.cacheWriteTtl.fiveM
            : null,
          storageCounts.cacheWriteTtl ? storageCounts.cacheWriteTtl.oneH : null
        );
      };
      // Join the caller's importer / lifecycle / sync transaction when given one;
      // otherwise wrap the read + upsert in our own atomic write transaction.
      if (tx) {
        await run(tx);
        return;
      }
      await prisma.write((client) => client.$transaction((itx) => run(itx)));
    },
    async getBySession(sessionId: string): Promise<TokenUsageRow[]> {
      const rows = await prisma.read((reader) =>
        reader.tokenUsage.findMany({
          where: { sessionId },
          select: {
            sessionId: true,
            model: true,
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            // FEA-3419: TTL subdivision for the local session-detail surface.
            cacheWrite5mTokens: true,
            cacheWrite1hTokens: true,
            createdAt: true,
            costUsdEstimated: true,
          },
          orderBy: { model: "asc" },
        })
      );
      // The token columns are BIGINT, so Prisma returns them as `bigint`;
      // toTokenUsageRow routes through readStorageTokenCount, which accepts
      // bigint and coerces to a JS-safe number (and preserves the shared cost
      // resolution). Marshal back to the snake_case shape the mapper expects.
      return rows.map((row) =>
        toTokenUsageRow({
          session_id: row.sessionId,
          model: row.model,
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cache_read_tokens: row.cacheReadTokens,
          cache_write_tokens: row.cacheWriteTokens,
          cache_write_5m_tokens: row.cacheWrite5mTokens,
          cache_write_1h_tokens: row.cacheWrite1hTokens,
          created_at: row.createdAt,
          cost_usd_estimated: row.costUsdEstimated,
        })
      );
    },
  };
}
