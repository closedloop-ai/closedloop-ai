/**
 * @file anthropic-admin-client.ts
 * @description Desktop-main (ESM) client for the Anthropic Admin Cost Report
 * (FEA-1435/1436): `GET https://api.anthropic.com/v1/organizations/cost_report`.
 * It fetches what Anthropic actually billed, grouped per day×model, so nightly
 * reconciliation can compare it against the local genai-prices estimate.
 *
 * ── What the endpoint returns (verified against the public API docs) ──────────
 * The response is `{ data: [{ starting_at, ending_at, results: [...] }],
 * has_more, next_page }`. Each result's `amount` is a DECIMAL STRING in the
 * lowest currency unit — i.e. cents — e.g. `"123.45"` USD means $1.23 (hence
 * cost-math.parseDecimalCentsToMicroCents, which parses that exact shape with no
 * float drift). We request `group_by[]=description` so each result carries a
 * `model` (token costs) — server-side tool costs (web_search/code_execution)
 * come back with `model: null` and are reported faithfully for the worker to
 * bucket. `bucket_width=1d` matches the reconciliation day grain.
 *
 * Auth is the org Admin key in the `x-api-key` header plus `anthropic-version`;
 * the key never appears in the URL. Pagination follows `next_page`; if the page
 * count would exceed the cap we throw rather than return a partial (and thus
 * understated) bill that would manufacture false drift.
 */
import {
  type AdminFetchLike,
  ANTHROPIC_API_HOST,
  asRecord,
  assertAllowedAdminHost,
  DEFAULT_ADMIN_FETCH,
  type ParsedBillingPage,
  parseDecimalCentsToMicroCents,
  requestAdminJson,
  utcDayFromRfc3339,
  type VendorBilledEntry,
} from "./admin-billing.js";

const COST_REPORT_URL = `https://${ANTHROPIC_API_HOST}/v1/organizations/cost_report`;
const ANTHROPIC_VERSION = "2023-06-01";
/** Time buckets (days) requested per page. Pagination covers longer windows. */
const BUCKET_LIMIT = 31;
/** Hard cap on pages to prevent an unbounded loop; exceeding it is an error. */
const DEFAULT_MAX_PAGES = 100;

export type AnthropicAdminClientOptions = {
  /** Org Admin key (`sk-ant-admin…`). Sent only in the x-api-key header. */
  apiKey: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: AdminFetchLike;
  /** Pagination safety cap (default 100). */
  maxPages?: number;
};

export type AnthropicCostReportQuery = {
  /** Inclusive lower bound, RFC 3339 (e.g. `2026-05-01T00:00:00Z`). */
  startingAt: string;
  /** Exclusive upper bound, RFC 3339. Optional. */
  endingAt?: string;
};

export class AnthropicAdminClient {
  private readonly apiKey: string;
  private readonly fetchImpl: AdminFetchLike;
  private readonly maxPages: number;

  constructor(options: AnthropicAdminClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("Anthropic admin key is required");
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? DEFAULT_ADMIN_FETCH;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * Fetch the full cost report for the window, following pagination. Returns one
   * VendorBilledEntry per result row (the worker aggregates per day×model).
   */
  async fetchCostReport(
    query: AnthropicCostReportQuery
  ): Promise<VendorBilledEntry[]> {
    const entries: VendorBilledEntry[] = [];
    let page: string | undefined;
    for (let pageCount = 0; pageCount < this.maxPages; pageCount += 1) {
      const url = this.buildUrl(query, page);
      assertAllowedAdminHost(url, ANTHROPIC_API_HOST);
      const payload = await requestAdminJson(
        url,
        {
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        this.fetchImpl,
        "Anthropic"
      );
      const parsed = parseCostReportPage(payload);
      entries.push(...parsed.entries);
      if (!parsed.hasMore) {
        return entries;
      }
      // has_more is true: a missing/non-string cursor means we cannot fetch the
      // rest, so returning now would silently understate the bill. Fail loud on
      // the malformed (untrusted) payload instead.
      if (!parsed.nextPage) {
        throw new Error(
          "Anthropic cost report claimed more pages (has_more) but returned no page cursor; aborting to avoid a partial (understated) bill"
        );
      }
      page = parsed.nextPage;
    }
    throw new Error(
      "Anthropic cost report exceeded the page cap; aborting to avoid a partial (understated) bill"
    );
  }

  private buildUrl(query: AnthropicCostReportQuery, page?: string): string {
    const url = new URL(COST_REPORT_URL);
    url.searchParams.set("starting_at", query.startingAt);
    if (query.endingAt) {
      url.searchParams.set("ending_at", query.endingAt);
    }
    url.searchParams.set("bucket_width", "1d");
    // Bracketed array param (verified): groups results so each carries a model.
    url.searchParams.append("group_by[]", "description");
    url.searchParams.set("limit", String(BUCKET_LIMIT));
    if (page) {
      url.searchParams.set("page", page);
    }
    return url.toString();
  }
}

/** Parse one cost_report page into normalized entries; strict about money. */
function parseCostReportPage(payload: unknown): ParsedBillingPage {
  const root = asRecord(payload);
  if (!(root && Array.isArray(root.data))) {
    throw new Error(
      "Anthropic cost report: malformed response (missing data[])"
    );
  }
  const entries: VendorBilledEntry[] = [];
  for (const bucketRaw of root.data) {
    const bucket = asRecord(bucketRaw);
    if (!bucket) {
      throw new Error("Anthropic cost report: malformed time bucket");
    }
    const day = utcDayFromRfc3339(bucket.starting_at, "Anthropic");
    if (!Array.isArray(bucket.results)) {
      throw new Error("Anthropic cost report: time bucket missing results[]");
    }
    for (const resultRaw of bucket.results) {
      const result = asRecord(resultRaw);
      if (!result) {
        throw new Error("Anthropic cost report: malformed result row");
      }
      if (typeof result.amount !== "string") {
        throw new Error(
          "Anthropic cost report: result amount must be a decimal string"
        );
      }
      const amountMicroCents = parseDecimalCentsToMicroCents(result.amount);
      const model = typeof result.model === "string" ? result.model : null;
      const label =
        typeof result.cost_type === "string" ? result.cost_type : null;
      entries.push({ day, model, amountMicroCents, label });
    }
  }
  return {
    entries,
    hasMore: root.has_more === true,
    nextPage: typeof root.next_page === "string" ? root.next_page : null,
  };
}
