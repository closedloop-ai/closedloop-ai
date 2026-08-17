/**
 * @file db-helpers.ts
 * @description Generic, dependency-light helpers shared across the desktop
 * store modules — value coercion, string/number parsing, ISO-date comparison,
 * GitHub-PR-URL/repo parsing, and SQL `LIKE` escaping. These are pure functions
 * with no Prisma/database dependency (the sole runtime import is the token-count
 * reader, itself pure; `TokenUsageCounts` is a type-only import, erased at
 * compile time). They were extracted verbatim from `sqlite.ts` so domain modules
 * can share them without re-importing the monolith.
 */
import { PLUGIN_CHILD_KINDS } from "@repo/api/src/types/agent-component";
import {
  ArtifactRefRelation,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import type { DashboardListWindow } from "../../shared/agent-db-contract.js";
import { asRecord } from "../../shared/type-guards.js";
import {
  parseOptionalStorageTokenCount,
  readStorageTokenCount,
} from "../cost/token-counts.js";
import type { TokenUsageCounts } from "../dashboard/agent-dashboard-db-types.js";

/** A `owner/repo` slug: word/dot/dash segments either side of a single slash. */
const GITHUB_REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;
/** A string consisting solely of ASCII digits. */
const INTEGER_STRING_RE = /^\d+$/;
/** First `/` or `:` separating a pack id from the rest of a skill name. */
const SKILL_NAME_SEPARATOR_RE = /[/:]/;
/** Run of id word separators: dash, underscore, whitespace, or slash. */
const ID_WORD_SEPARATOR_RE = /[-_\s/]+/;
/** A line break, CRLF or LF. */
const LINE_SPLIT_RE = /\r?\n/;
/** Leading markdown heading hashes plus any trailing spaces. */
const MARKDOWN_HEADING_PREFIX_RE = /^#+\s*/;
/** A component kind safe to interpolate into SQL: bare lowercase identifier. */
const SQL_SAFE_COMPONENT_KIND_RE = /^[a-z][a-z_]*$/;

export function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return asRecord(value);
  } catch {
    return null;
  }
}

export function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && INTEGER_STRING_RE.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

// FEA-2430: display-facing day/hour SQL bucket expressions convert UTC-stored
// ISO timestamps to the user's LOCAL timezone. Shared by local-insights.ts
// (which documents the full timezone contract) and dashboard-queries.ts.
export function localDay(col: string): string {
  return `strftime('%Y-%m-%d', ${col}, 'localtime')`;
}

export function localHour(col: string): string {
  return `CAST(strftime('%H', ${col}, 'localtime') AS INTEGER)`;
}

// FEA-2430/FEA-3006: the LOCAL yyyy-MM-dd key for a JS Date, the JS-side twin of
// the `localDay()` SQL bucket — the two must stay in lockstep (see the timezone
// contract in local-insights.ts). Reads the Date's LOCAL calendar fields so a
// UTC-based formatter can't drift a day for non-UTC users. Callers that need a
// day key from a Date (`local-insights.ts`'s eachDay, the optimization-analytics
// window cutoff) share this instead of re-deriving the format.
export function formatLocalDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// FEA-3006: the inclusive LOCAL-day cutoff for a rolling `windowDays` window
// (today plus the prior windowDays-1 local days) as a `formatLocalDayKey`
// string, so it compares directly against the `localDay()` day buckets the
// optimization-analytics queries GROUP BY. `now` is injectable so the cutoff is
// deterministically testable under a pinned timezone.
export function localCutoffDay(
  windowDays: number,
  now: Date = new Date()
): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (windowDays - 1));
  return formatLocalDayKey(cutoff);
}

// FEA-2862: the DISTINCT set of artifacts a session actually authored
// (relation='created', collapsing multi-session created links so one PR fans
// out to at most one row). Shared by the trend query (agent_n LEFT JOIN) and
// the "Merged PRs by repository" breakdown (in-session INNER JOIN) in
// local-insights-delivery.ts, so relation-classification changes update in one
// place.
// Join it under an alias, e.g. `JOIN ${createdArtifactLinksSubquery()} cl ON ...`.
export function createdArtifactLinksSubquery(): string {
  return `(SELECT DISTINCT artifact_id FROM session_artifact_links
             WHERE relation = '${ArtifactRefRelation.Created}')`;
}

// ISS-5936: the non-delivery-only artifact gate (FEA-3585 / ISS-5764) moved to
// `non-delivery-artifacts.ts`. It is no longer a bare subquery string pasted per
// statement — callers resolve the id set ONCE per call and render it — and the
// resolver executes a query, which this module does not do (see the header).

export function nullableNumber(
  value: number | null | undefined
): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * FEA-3267: a non-negative integer within the cloud wire schema's `PR_INT_MAX`
 * (Postgres int4) bound, else undefined. The desktop syncs LOC into int4 sink
 * columns, so an overflowed SQLite SUM (64-bit) that cleared a bare `>= 0` check
 * would fail the cloud's batch parse / int4 upsert and reject every session in
 * the batch. Shared by the PR/commit-ref LOC path and session diff-stats.
 */
export function boundedNonNegativeInt(
  value: number | null
): number | undefined {
  return value != null &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= PR_INT_MAX
    ? value
    : undefined;
}

// FEA-3131: coerce a numeric-ish value to a plain JS number, mapping null/
// undefined to 0. Prisma's raw read path can surface SQLite INTEGER aggregates
// (COUNT/SUM) as `bigint`; `Number()` normalizes every form — number, bigint,
// or numeric string — to the JS number the desktop contract uses. Shared by
// local-insights.ts and shared-agent-components-api.ts, which previously each
// hand-rolled this coercion (as `num`/`toNumber`).
export function numberOrZero(
  value: number | bigint | string | null | undefined
): number {
  return value == null ? 0 : Number(value);
}

export function parseGitHubPrUrl(
  value: string
): { repoFullName: string; number: number } | null {
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const [owner, repo, type, rawNumber] = parsed.pathname
      .split("/")
      .filter(Boolean);
    if (!(owner && repo && type === "pull")) {
      return null;
    }
    const number = numberFromUnknown(rawNumber);
    return number ? { repoFullName: `${owner}/${repo}`, number } : null;
  } catch {
    return null;
  }
}

export function normalizeRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return GITHUB_REPO_FULL_NAME_RE.test(normalized) ? normalized : null;
}

export function packIdFromSkillName(name: string): string | null {
  const normalized = name.trim();
  const separatorIndex = normalized.search(SKILL_NAME_SEPARATOR_RE);
  if (separatorIndex <= 0) {
    return null;
  }
  return normalized.slice(0, separatorIndex);
}

export function titleFromId(id: string): string {
  return (
    id
      .split(ID_WORD_SEPARATOR_RE)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || id
  );
}

export function titleFromPlan(content: string): string {
  const firstLine =
    content
      .split(LINE_SPLIT_RE)
      .map((line) => line.replace(MARKDOWN_HEADING_PREFIX_RE, "").trim())
      .find((line) => line.length > 0) ?? "Untitled plan";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function compareIsoDesc(a: string | null, b: string | null): number {
  const left = a ? Date.parse(a) : 0;
  const right = b ? Date.parse(b) : 0;
  return (
    (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0)
  );
}

export function validIso(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * FEA-3743: normalize any parseable timestamp to the canonical ISO-8601 UTC 'Z'
 * form (e.g. `2026-06-18T08:00:00.000Z`) BEFORE it is persisted to the SQLite
 * store. Every timestamp column in the desktop store is a text string that all
 * downstream SQL sorts and compares LEXICALLY; alphabetical order only matches
 * chronological order when every value is written in this one canonical form.
 * Offset-form inputs (`...+02:00`, `...-05:00`) sort by their wall-clock digits,
 * not their real instant, so a mixed-format column can answer "which came
 * first?" incorrectly. Normalizing at write time keeps the whole column
 * single-format.
 *
 * The instant is preserved exactly (`new Date(...).toISOString()` re-expresses
 * the SAME moment in UTC). Returns the input unchanged if it is not a parseable
 * timestamp, so callers never lose a value they cannot canonicalize.
 */
export function toCanonicalIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString();
}

export function maxIso(a: string | null, b: string | null): string | null {
  return compareIsoDesc(a, b) <= 0 ? a : b;
}

export function minIso(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return compareIsoDesc(a, b) >= 0 ? a : b;
}

export function compareLastUsedThenName<
  T extends { name: string; lastUsedAt: string | null },
>(a: T, b: T): number {
  const byDate = compareIsoDesc(a.lastUsedAt, b.lastUsedAt);
  return byDate === 0 ? a.name.localeCompare(b.name) : byDate;
}

export function truncate(
  value: string | null | undefined,
  max: number
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

export function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function escapeSqliteLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function tokenCountValue(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, `sqlite.${fieldName}`);
}

/**
 * Coerce a `TokenUsageCounts` (the four token totals) through `tokenCountValue`,
 * validating each field at the storage boundary. Shared by the token-usage store
 * write path and the importer's token persistence.
 */
export function normalizeTokenUsageCounts(
  counts: TokenUsageCounts,
  context: string
): TokenUsageCounts {
  return {
    input: tokenCountValue(counts.input, `${context}.input_tokens`),
    output: tokenCountValue(counts.output, `${context}.output_tokens`),
    cacheRead: tokenCountValue(
      counts.cacheRead,
      `${context}.cache_read_tokens`
    ),
    cacheWrite: tokenCountValue(
      counts.cacheWrite,
      `${context}.cache_write_tokens`
    ),
    // FEA-3419: the TTL subdivision passes the same storage-boundary validation
    // as the canonical counters; absent stays absent (NULL provenance).
    ...(counts.cacheWriteTtl
      ? {
          cacheWriteTtl: {
            fiveM: tokenCountValue(
              counts.cacheWriteTtl.fiveM,
              `${context}.cache_write_5m_tokens`
            ),
            oneH: tokenCountValue(
              counts.cacheWriteTtl.oneH,
              `${context}.cache_write_1h_tokens`
            ),
          },
        }
      : {}),
  };
}

/**
 * Optional counterpart to `tokenCountValue`: a NULL/absent column stays `null`
 * (unknown), and a present value passes the same storage-boundary validation.
 * Callers that must keep "not populated" distinguishable from "zero" use this
 * instead of hand-rolling the null branch around `tokenCountValue`.
 */
export function optionalTokenCountValue(
  value: unknown,
  fieldName: string
): number | null {
  return parseOptionalStorageTokenCount(value, `sqlite.${fieldName}`);
}

/**
 * ISS-5493: the ONE definition of "this event is a tool invocation", as a SQL
 * predicate over an `events.tool_name` column reference.
 *
 * The canonical JS fold (`buildAnalytics` in shared-agent-sessions-api.ts) skips
 * an event on the falsy `!event.toolName` test, so it drops BOTH NULL and the
 * empty string. An empty `tool_name` is reachable in practice — live-hook.ts
 * stores the hook payload's `data.tool_name` verbatim — and every SQL reader
 * that filtered on `tool_name IS NOT NULL` alone therefore counted an
 * empty-named "tool" the hydrate path drops, and grouped it as its own nameless
 * row. The `session_tool_analytics` / `session_analytics` rollups already used
 * the stricter form, so the readers disagreed with the rollups too.
 *
 * Every tool-count read and the rollup writer share this helper so the four
 * surfaces (Insights `tools` KPI, `toolUsage`, `toolRunsOverTime`, and the
 * analytics `byTool` breakdown) cannot drift apart again — a mismatch between
 * any two of them is directly visible as two different totals on one screen.
 *
 * Parenthesized so it stays correct if a caller ever embeds it beside an `OR`.
 */
export function toolInvocationPredicate(column: string): string {
  return `(${column} IS NOT NULL AND ${column} <> '')`;
}

/**
 * FEA-1459 Fix 6: Resolve the machine's IANA timezone for day-bucketing queries.
 * Falls back to "UTC" if Intl is unavailable.
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * ISS-5631 / ISS-6451: clamp an untrusted dashboard page window. Same shape as
 * read-stores' `coercePageRequest`: an absent or non-finite bound falls back to
 * the default, `limit` floors at 1 and is CAPPED at `maxLimit` so the read cannot
 * be widened back to the whole corpus, and `offset` floors at 0 so a negative
 * value cannot turn the window into a suffix read. `maxLimit` is the caller's
 * own ceiling constant (`MAX_DASHBOARD_PLAN_PAGE_LIMIT` for `getPlans`,
 * `MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT` for `getPullRequests`) — one clamp,
 * so the two windows cannot drift apart.
 *
 * A FRACTIONAL bound truncates toward the caller's intent rather than falling
 * back: `Number.isInteger` alone sent `limit: 33.33` to the `maxLimit` default,
 * so a malformed NARROW request silently WIDENED to the full page. Only a value
 * that carries no window at all (absent, `NaN`, `Infinity`) may default.
 *
 * `offset` is capped at `Number.MAX_SAFE_INTEGER` as well as floored, because
 * unlike `limit` it has no domain ceiling and now reaches SQL directly. Verified
 * against the live store: an offset up to `MAX_SAFE_INTEGER` returns an empty
 * page, and one beyond it rejects with a message-less driver error that would
 * surface out of the IPC handler. Clamping degrades an absurd offset to the same
 * empty page any past-the-corpus offset already returns, rather than defaulting
 * it to 0 — which would hand the caller page 1 while it asked for page 10^19.
 */
export function coerceDashboardListWindow(
  opts: DashboardListWindow | undefined,
  maxLimit: number
): {
  limit: number;
  offset: number;
} {
  const requestedLimit = opts?.limit;
  const limit =
    typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), maxLimit)
      : maxLimit;
  const requestedOffset = opts?.offset;
  const offset =
    typeof requestedOffset === "number" && Number.isFinite(requestedOffset)
      ? Math.min(
          Math.max(Math.trunc(requestedOffset), 0),
          Number.MAX_SAFE_INTEGER
        )
      : 0;
  return { limit, offset };
}

/**
 * ISS-6094: {@link PLUGIN_CHILD_KINDS} rendered as a SQL literal list —
 * `'skill', 'command', …` — for the desktop rollup readers and the `pack_id`
 * backfill, which build statement text rather than passing a Prisma `in` array.
 *
 * The KIND LIST is the cross-surface contract and lives in `@repo/api`, where
 * the cloud rollup and both app surfaces read it. Rendering it into SQLite
 * statement text is a desktop persistence detail, so it lives here (PR #4916
 * review — wongk; `packages/api/AGENTS.md` keeps persistence implementation out
 * of the transport-contract package). Those raw-SQL sites each carried their own
 * hardcoded copy and had already drifted — the backfill covered
 * `('skill', 'command')` while every reader joined
 * `('skill','command','subagent','mcp')`, so a subagent or MCP child could never
 * be linked to its plugin and any plugin whose children are subagents or MCP
 * servers rolled up to a permanent zero. They read this instead.
 *
 * Interpolating it is safe and stays safe: every member is a compile-time
 * `AgentComponentKind`, never user input, and the guard rejects anything that is
 * not a bare lowercase identifier, so a future kind containing a quote fails
 * loudly at module load instead of producing malformed SQL.
 */
export const PLUGIN_CHILD_KINDS_SQL_LIST: string = PLUGIN_CHILD_KINDS.map(
  (kind) => {
    if (!SQL_SAFE_COMPONENT_KIND_RE.test(kind)) {
      throw new Error(
        `PLUGIN_CHILD_KINDS_SQL_LIST: "${kind}" is not a bare lowercase identifier and cannot be interpolated into SQL`
      );
    }
    return `'${kind}'`;
  }
).join(", ");
