/**
 * @file claude-code-analytics-client.ts
 * @description Desktop-main (ESM) client for the Anthropic Claude Code Analytics
 * report (FEA-1436): `GET https://api.anthropic.com/v1/organizations/usage_report/
 * claude_code`. It reads Anthropic's OWN per-user, per-model Claude Code usage and
 * estimated spend for a window of days, so the desktop app can show a "who spent
 * what on Claude Code" breakdown alongside the local genai-prices ledger.
 *
 * ── Relationship to the genai-prices single source of truth ──────────────────
 * This endpoint returns ANTHROPIC'S estimate (`model_breakdown[].estimated_cost`),
 * NOT a genai-prices figure. It is purely informational and is NEVER used to
 * override, clamp, or "correct" any genai-prices number — the local ledger stays
 * the single source of truth for our own cost accounting. The UI labels this data
 * as Anthropic's own estimate to keep the two sources visibly distinct.
 *
 * ── What the endpoint returns (verified against the public API docs) ──────────
 * The report is SINGLE-DAY-per-request: `starting_at` is one UTC calendar day
 * (`YYYY-MM-DD`), so a multi-day window is covered by looping one request per day.
 * Within a day, results paginate via an opaque `page` cursor (`{ data, has_more,
 * next_page }`). Each `data[]` record is one actor's usage for the day:
 *   - `actor`: `{ type: "user_actor", email_address }` (a person) or
 *     `{ type: "api_actor", api_key_name }` (an API key label — a name, not a key);
 *   - `model_breakdown[]`: per-model `{ model, estimated_cost: { amount, currency },
 *     tokens: { input, output, cache_creation, cache_read } }`. `estimated_cost.amount`
 *     is a NUMBER in the currency's MINOR units (cents for USD) — hence
 *     cost-math.centsToMicroCents.
 * We flatten this to one normalized record per actor×model×day.
 *
 * Auth is the org Admin key in the `x-api-key` header plus `anthropic-version`;
 * the key never appears in the URL. Both the per-day loop and the per-day page
 * loop are capped; exceeding a cap throws rather than silently returning a partial
 * (understated) usage picture.
 */
import {
  type AdminFetchLike,
  ANTHROPIC_API_HOST,
  asRecord,
  assertAllowedAdminHost,
  centsToMicroCents,
  DEFAULT_ADMIN_FETCH,
  requestAdminJson,
} from "./admin-billing.js";

const ANALYTICS_URL = `https://${ANTHROPIC_API_HOST}/v1/organizations/usage_report/claude_code`;
const ANTHROPIC_VERSION = "2023-06-01";
/** Records requested per page (the endpoint allows up to 1000). */
const PAGE_LIMIT = 1000;
/** Per-day pagination safety cap; exceeding it is an error (partial = misleading). */
const DEFAULT_MAX_PAGES_PER_DAY = 50;
/** Window safety cap so a runaway range can never spawn unbounded day requests. */
const MAX_WINDOW_DAYS = 92;

/** Whether the actor is a human user (email) or an API key (named label). */
export type ClaudeCodeActorType = "user" | "api_key";

/** One normalized Claude Code usage record at the actor×model×day grain. */
export type ClaudeCodeUsageRecord = {
  /** UTC calendar day, ISO `YYYY-MM-DD`. */
  day: string;
  /** Actor identity: a user's email address, or an API key's name. */
  actor: string;
  /** Whether `actor` is a human user (email) or an API key label. */
  actorType: ClaudeCodeActorType;
  /** Model id Anthropic reported usage for. */
  model: string;
  /**
   * Anthropic's OWN estimated cost for this actor×model×day, in integer
   * micro-cents (see cost-math.ts). This is Anthropic's estimate, NOT a
   * genai-prices figure — it never overrides the local ledger.
   */
  estimatedCostMicroCents: number;
  /** Uncached input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache-creation (write) input tokens. */
  cacheCreationTokens: number;
  /** Cache-read input tokens. */
  cacheReadTokens: number;
};

export type ClaudeCodeAnalyticsClientOptions = {
  /** Org Admin key (`sk-ant-admin…`). Sent only in the x-api-key header. */
  apiKey: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: AdminFetchLike;
  /** Per-day pagination safety cap (default 50). */
  maxPagesPerDay?: number;
};

export type ClaudeCodeAnalyticsQuery = {
  /** Inclusive first UTC day, `YYYY-MM-DD`. */
  startDay: string;
  /** Inclusive last UTC day, `YYYY-MM-DD`. Must be ≥ startDay. */
  endDay: string;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a `YYYY-MM-DD` day string and return it; throws on a bad shape. */
function assertUtcDayString(value: string, field: string): string {
  if (!DAY_PATTERN.test(value)) {
    throw new Error(`Claude Code analytics: ${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Claude Code analytics: ${field} is not a real date`);
  }
  // JS Date silently overflows out-of-range days (e.g. 2024-02-30 → 2024-03-01),
  // so the NaN check above is not enough. Require the parsed date to round-trip
  // back to the same string, which rejects impossible calendar days.
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Claude Code analytics: ${field} is not a real date`);
  }
  return value;
}

/**
 * Enumerate UTC calendar days from `startDay` to `endDay` inclusive. Throws if
 * the range is inverted or exceeds the window cap (the endpoint is one request
 * per day, so an unbounded range would mean unbounded requests).
 */
function enumerateUtcDays(startDay: string, endDay: string): string[] {
  const start = Date.parse(`${startDay}T00:00:00Z`);
  const end = Date.parse(`${endDay}T00:00:00Z`);
  if (end < start) {
    throw new Error("Claude Code analytics: endDay is before startDay");
  }
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
    if (days.length > MAX_WINDOW_DAYS) {
      throw new Error(
        `Claude Code analytics: window exceeds ${MAX_WINDOW_DAYS} days`
      );
    }
  }
  return days;
}

export class ClaudeCodeAnalyticsClient {
  private readonly apiKey: string;
  private readonly fetchImpl: AdminFetchLike;
  private readonly maxPagesPerDay: number;

  constructor(options: ClaudeCodeAnalyticsClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("Anthropic admin key is required");
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? DEFAULT_ADMIN_FETCH;
    this.maxPagesPerDay = options.maxPagesPerDay ?? DEFAULT_MAX_PAGES_PER_DAY;
  }

  /**
   * Fetch the per-actor×model usage for every day in the window. Loops one
   * request per day (the endpoint's grain), following each day's `next_page`
   * cursor. Returns the flattened, normalized records across all days.
   */
  async fetchUsage(
    query: ClaudeCodeAnalyticsQuery
  ): Promise<ClaudeCodeUsageRecord[]> {
    const startDay = assertUtcDayString(query.startDay, "startDay");
    const endDay = assertUtcDayString(query.endDay, "endDay");
    const records: ClaudeCodeUsageRecord[] = [];
    for (const day of enumerateUtcDays(startDay, endDay)) {
      records.push(...(await this.fetchDay(day)));
    }
    return records;
  }

  /** Fetch and paginate a single UTC day. */
  private async fetchDay(day: string): Promise<ClaudeCodeUsageRecord[]> {
    const records: ClaudeCodeUsageRecord[] = [];
    let page: string | undefined;
    for (let pageCount = 0; pageCount < this.maxPagesPerDay; pageCount += 1) {
      const url = this.buildUrl(day, page);
      assertAllowedAdminHost(url, ANTHROPIC_API_HOST);
      const payload = await requestAdminJson(
        url,
        {
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        this.fetchImpl,
        "Anthropic Claude Code analytics"
      );
      const parsed = parseAnalyticsPage(payload, day);
      records.push(...parsed.records);
      if (!parsed.hasMore) {
        return records;
      }
      // has_more is true: a missing/non-string cursor means we cannot fetch the
      // rest of the day, so returning now would silently understate usage. Fail
      // loud on the malformed (untrusted) payload instead.
      if (!parsed.nextPage) {
        throw new Error(
          `Claude Code analytics for ${day} claimed more pages (has_more) but returned no page cursor; aborting to avoid a partial usage picture`
        );
      }
      page = parsed.nextPage;
    }
    throw new Error(
      `Claude Code analytics for ${day} exceeded the page cap; aborting to avoid a partial usage picture`
    );
  }

  private buildUrl(day: string, page?: string): string {
    const url = new URL(ANALYTICS_URL);
    url.searchParams.set("starting_at", day);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (page) {
      url.searchParams.set("page", page);
    }
    return url.toString();
  }
}

type ParsedAnalyticsPage = {
  records: ClaudeCodeUsageRecord[];
  hasMore: boolean;
  nextPage: string | null;
};

/** Resolve the actor identity + type from a `data[]` record's `actor` object. */
function parseActor(raw: unknown): {
  actor: string;
  actorType: ClaudeCodeActorType;
} {
  const actor = asRecord(raw);
  if (actor) {
    if (
      actor.type === "user_actor" &&
      typeof actor.email_address === "string" &&
      actor.email_address.length > 0
    ) {
      return { actor: actor.email_address, actorType: "user" };
    }
    if (
      actor.type === "api_actor" &&
      typeof actor.api_key_name === "string" &&
      actor.api_key_name.length > 0
    ) {
      return { actor: actor.api_key_name, actorType: "api_key" };
    }
  }
  // Unknown/future actor shapes are surfaced (not dropped) under a stable label
  // so spend is never silently hidden; type defaults to api_key (non-PII).
  return { actor: "(unknown actor)", actorType: "api_key" };
}

/** Read a finite non-negative token count, defaulting absent fields to 0. */
function tokenCount(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return 0;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error("Claude Code analytics: token count must be a number");
  }
  if (raw < 0) {
    throw new Error("Claude Code analytics: token count must be non-negative");
  }
  return raw;
}

/** Parse one analytics page into normalized records; strict about money. */
function parseAnalyticsPage(
  payload: unknown,
  day: string
): ParsedAnalyticsPage {
  const root = asRecord(payload);
  if (!(root && Array.isArray(root.data))) {
    throw new Error(
      "Claude Code analytics: malformed response (missing data[])"
    );
  }
  const records: ClaudeCodeUsageRecord[] = [];
  for (const recordRaw of root.data) {
    const record = asRecord(recordRaw);
    if (!record) {
      throw new Error("Claude Code analytics: malformed data record");
    }
    const { actor, actorType } = parseActor(record.actor);
    if (!Array.isArray(record.model_breakdown)) {
      // A record with no model breakdown contributed no per-model spend.
      continue;
    }
    for (const breakdownRaw of record.model_breakdown) {
      const breakdown = asRecord(breakdownRaw);
      if (!breakdown) {
        throw new Error(
          "Claude Code analytics: malformed model_breakdown entry"
        );
      }
      if (typeof breakdown.model !== "string") {
        throw new Error(
          "Claude Code analytics: model_breakdown.model must be a string"
        );
      }
      const estimated = asRecord(breakdown.estimated_cost);
      if (
        !estimated ||
        typeof estimated.amount !== "number" ||
        !Number.isFinite(estimated.amount)
      ) {
        throw new Error(
          "Claude Code analytics: estimated_cost.amount must be a number (minor units)"
        );
      }
      const tokens = asRecord(breakdown.tokens) ?? {};
      records.push({
        day,
        actor,
        actorType,
        model: breakdown.model,
        estimatedCostMicroCents: centsToMicroCents(estimated.amount),
        inputTokens: tokenCount(tokens.input),
        outputTokens: tokenCount(tokens.output),
        cacheCreationTokens: tokenCount(tokens.cache_creation),
        cacheReadTokens: tokenCount(tokens.cache_read),
      });
    }
  }
  return {
    records,
    hasMore: root.has_more === true,
    nextPage: typeof root.next_page === "string" ? root.next_page : null,
  };
}
