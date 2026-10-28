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
  REPOSITORY_FULL_NAME_MAX_LENGTH,
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
/**
 * ISS-5496: a date-TIME with no zone designator at all (`2026-06-22T10:00:00`,
 * `2026-06-22T10:00`, `2026-06-22T10:00:00.5`). The character class is POSITIVE
 * — digits, `:`, `.` — rather than a negated "no Z and no sign", so a trailing
 * `Z`/`z` or a `+HH:MM`/`-HHMM` offset falls out on its own and no unlisted
 * suffix can be mistaken for a zone-less tail.
 */
const ZONE_LESS_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

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
//
// ISS-7579: these are the DISPLAY-facing twins of `storedUtcDaySql`
// (session-timestamp-form.ts), which buckets the STORED UTC day for a persisted
// `started_day` column. Pick by destination, not convenience: a value being
// rendered bucket here, a value being written there. That helper carries the
// ISS-6760 ledger explaining why a stored UTC day must never become a
// cohort/group-by axis — the FEA-2999 bug was exactly that mistake.
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

/**
 * The null-degrading twin of {@link numberOrZero}: same input union, same
 * finite check, but a value carrying no number stays `null` (unknown) instead
 * of reading as a real 0. Use this where a 0 would LIE — a cost that was never
 * computed, a column that may not be populated; use `numberOrZero` where the
 * figure is a COUNT/SUM-shaped total and absent genuinely means none.
 *
 * ISS-7580 widened the input union to match `numberOrZero` so a raw `bigint`
 * aggregate or a TEXT cell can pick either degradation without a cast. The two
 * are deliberately ONE pair in one module: a separate `numberOrNull` would be
 * this function under a second name.
 */
export function nullableNumber(
  value: number | bigint | string | null | undefined
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
//
// ISS-7580: a value that carries NO number reads 0 as well, because the name is
// the contract. Callers apply this to `$queryRawUnsafe` rows, and SQLite stores
// whatever was written — affinity converts what it can and keeps the rest
// verbatim — so a corrupt cell arrives as TEXT and `Number("n/a")` is NaN.
//
// Which escape from the numeric domain you get depends on how the cell is read,
// measured against `node:sqlite`: a BARE, non-aggregate read hands JS the
// literal `"n/a"` (NaN), while `SUM` applies numeric affinity first, so the same
// text sums to 0 and an overflowing `"1e999"` sums to `Infinity`. `isFinite`
// rather than `isNaN` because both are values this helper must not emit.
//
// 0 is the honest degradation only where the reader treats the figure as a
// COUNT/SUM-shaped total and absent genuinely means none. Where "not populated"
// must stay distinguishable from a real zero — a version, an identity, a
// conservation target — use {@link nullableNumber}, the same coercion degrading
// to null.
export function numberOrZero(
  value: number | bigint | string | null | undefined
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse a github.com pull-request URL into the `(repo, number)` identity it
 * names, or say why it names none.
 *
 * The refusal rides on the result because ONE caller has to tell
 * `RepoPastWireBound` from every other refusal, and that answer comes out of
 * this same traversal. A second predicate re-deriving the hostname, the path
 * shape and the number to reach it is SSOT drift by copy — and the copy this
 * replaces had already drifted inside one review round (PR #6627: it was
 * missing the number check, so it reported a `/pull/not-a-number` URL as
 * over-bound and dropped a record the malformed-URL path had always kept).
 */
export function parseGitHubPrUrl(value: string): GitHubPrUrlParse {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return NOT_A_PR_URL;
  }
  if (parsed.hostname !== "github.com") {
    return NOT_A_PR_URL;
  }
  const [owner, repo, type, rawNumber] = parsed.pathname
    .split("/")
    .filter(Boolean);
  if (!(owner && repo && type === "pull")) {
    return NOT_A_PR_URL;
  }
  const number = numberFromUnknown(rawNumber);
  if (!number) {
    return NOT_A_PR_URL;
  }
  const slug = `${owner}/${repo}`;
  // ISS-8882: the URL-derived slug takes the same bound as a stored one, so a
  // 205-char owner/repo never reaches `pull_requests` or `artifacts`. It is
  // named apart from the other refusals because it is the only one a caller
  // must not fall back from — see `GitHubPrUrlRefusal`.
  if (isRepoFullNamePastWireBound(slug)) {
    return REPO_PAST_WIRE_BOUND;
  }
  const repoFullName = normalizeRepoFullName(slug);
  return repoFullName ? { ok: true, repoFullName, number } : NOT_A_PR_URL;
}

export function normalizeRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length <= REPOSITORY_FULL_NAME_MAX_LENGTH &&
    GITHUB_REPO_FULL_NAME_RE.test(normalized)
    ? normalized
    : null;
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
 * row. The `session_analytics` rollup already used the stricter form, so the
 * readers disagreed with the rollup too.
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
 * Milliseconds in a day, for the day-window arithmetic several readers and the
 * retention sweep all do. Here rather than in any one of them because it
 * belongs to none of them: it was independently re-declared in
 * `session-maintenance.ts`, `local-insights-range.ts` and two `cost/` modules
 * before ISS-6751 needed a fifth.
 */
export const MS_PER_DAY = 24 * 60 * 60_000;

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
 * review — whitlockk; `packages/api/AGENTS.md` keeps persistence implementation out
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

// The row shape a `localDay()`-bucketed COUNT produces. Shared by the per-day
// trend reads across the Insights section modules so they cannot drift.
export type DayCount = { day: string; n: bigint };

/**
 * ISS-5496 / ISS-8398: name the zone of a ZONE-LESS date-time as UTC, leaving
 * every other spelling untouched.
 *
 * This one expression IS the store's "a zone-less date-time means UTC" rule, and
 * it lives here — beside {@link toCanonicalIso} and {@link validIso}, its only
 * collaborators — because it now has two callers that must never disagree:
 * `canonicalizeStoredTimestamp` (`timestamp-format-maintenance.ts`, the ISS-5496
 * heal) and `toLegacyAgentInstant` (`turn-buckets.ts`, the ISS-8398 legacy Agent
 * arm). Re-typing the ternary in the second caller is the SSOT-drift-by-copy
 * this repo names explicitly, so the REGEX stays private and the RULE is what is
 * exported.
 *
 * UTC is not invented here. `Date.parse` reads a zone-less date-time as
 * HOST-LOCAL per ECMA-262, which makes output depend on the operator's `TZ`;
 * every other reader of these TEXT columns already treats the digits as UTC —
 * SQLite's `unixepoch()`/`strftime` over the same text, the lexical comparisons
 * the columns are sorted by, `toIso` at the parser boundary (ISS-6738), and the
 * cloud's own `(… ->> 'timestamp')::timestamp` + `AT TIME ZONE 'UTC'` read. So
 * supplying the zone the text omits is what makes a value deterministic and
 * zone-independent, not what changes its meaning.
 *
 * ONLY the zone is supplied — no canonicalization, no parse, no validation. The
 * caller decides what an unparseable result means, and the two callers differ
 * there on purpose: the heal returns the ORIGINAL stored text so its skip guard
 * leaves the row alone, while the bucket arm REJECTS the unit outright.
 */
export function readZoneLessAsUtc(value: string): string {
  return ZONE_LESS_DATE_TIME_RE.test(value) ? `${value}Z` : value;
}

// ISS-8882: `normalizeRepoFullName` returns null for two reasons a caller must
// NOT conflate. A bare or malformed name is recoverable — a later resolver sweep
// can still map it, and the established posture is to null-scope it (FEA-2866).
// A slug past the wire bound never becomes valid, so the same null-scoping is
// actively wrong: it collapses distinct over-bound repositories onto one
// `branch::<name>` / `pr::<number>` artifact, and a `?? defaultRepo` fallback
// files the record under a repository the data never named — the truncation harm
// this ticket exists to prevent, one indirection away. Every caller that
// DEGRADES on null must reject this kind outright, before the degrade.
export function isRepoFullNamePastWireBound(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > REPOSITORY_FULL_NAME_MAX_LENGTH
  );
}

/**
 * Why {@link parseGitHubPrUrl} refused a URL.
 *
 * `RepoPastWireBound` is the ONE refusal a caller must not fall back from: the
 * URL named a real repository, this store just cannot hold its slug, so filing
 * the PR on the session's own repo would name a repository the data never did —
 * the truncation harm the drop-never-truncate rule exists to prevent, one
 * indirection away. Every other refusal leaves no usable repository either way,
 * so an explicit `pr.repo` or the session default may still stand (ISS-8882).
 */
export const GitHubPrUrlRefusal = {
  NotAPrUrl: "not_a_pr_url",
  RepoPastWireBound: "repo_past_wire_bound",
} as const;
export type GitHubPrUrlRefusal =
  (typeof GitHubPrUrlRefusal)[keyof typeof GitHubPrUrlRefusal];

export type GitHubPrUrlParse =
  | { ok: true; repoFullName: string; number: number }
  | { ok: false; refusal: GitHubPrUrlRefusal };

const NOT_A_PR_URL: GitHubPrUrlParse = {
  ok: false,
  refusal: GitHubPrUrlRefusal.NotAPrUrl,
};
const REPO_PAST_WIRE_BOUND: GitHubPrUrlParse = {
  ok: false,
  refusal: GitHubPrUrlRefusal.RepoPastWireBound,
};
