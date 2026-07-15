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
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { asRecord } from "../../shared/type-guards.js";
import type { TokenUsageCounts } from "../agent-dashboard-db-types.js";
import { readStorageTokenCount } from "../token-counts.js";

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
// local-insights.ts, so relation-classification changes update in one place.
// Join it under an alias, e.g. `JOIN ${createdArtifactLinksSubquery()} cl ON ...`.
export function createdArtifactLinksSubquery(): string {
  return `(SELECT DISTINCT artifact_id FROM session_artifact_links
             WHERE relation = '${ArtifactRefRelation.Created}')`;
}

export function nullableNumber(
  value: number | null | undefined
): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  };
}
