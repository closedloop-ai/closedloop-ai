/**
 * @file openai-admin-client.ts
 * @description Desktop-main (ESM) client for the OpenAI organization Costs
 * endpoint (FEA-1435/1436): `GET https://api.openai.com/v1/organization/costs`.
 * It fetches what OpenAI actually billed per day so nightly reconciliation can
 * compare it against the local genai-prices estimate.
 *
 * ── What the endpoint returns (verified against the public API docs) ──────────
 * `{ object: "page", data: [{ object: "bucket", start_time, end_time,
 * results: [{ amount: { value, currency }, line_item, project_id, … }] }],
 * has_more, next_page }`. `start_time` is Unix epoch SECONDS; `amount.value` is
 * a NUMBER in USD DOLLARS (currency lowercase, e.g. "usd") — hence
 * cost-math.usdToMicroCents. `bucket_width=1d` matches the reconciliation day
 * grain.
 *
 * ── Day-grain only, by design ────────────────────────────────────────────────
 * Unlike Anthropic's cost_report, the OpenAI Costs endpoint does NOT break costs
 * down per model — its grouping dimensions are line_item / project_id /
 * api_key_id, none of which is a model id. So we deliberately do NOT pass
 * `group_by`: each bucket then yields the day's TOTAL, which we return with
 * `model: null`. The reconciliation worker compares this against the local
 * estimate summed across all OpenAI models for that day (day grain), rather than
 * fabricating a per-model split the vendor never provided.
 *
 * Auth is the org Admin key as a Bearer token; the key never appears in the URL.
 * Pagination follows `next_page`; exceeding the page cap throws rather than
 * returning a partial (understated) bill.
 */
import {
  type AdminFetchLike,
  asRecord,
  assertAllowedAdminHost,
  DEFAULT_ADMIN_FETCH,
  OPENAI_API_HOST,
  type ParsedBillingPage,
  requestAdminJson,
  usdToMicroCents,
  utcDayFromUnixSeconds,
  type VendorBilledEntry,
} from "./admin-billing.js";

const COSTS_URL = `https://${OPENAI_API_HOST}/v1/organization/costs`;
/** Max buckets (days) per page; the endpoint allows 1–180 and we take the max. */
const BUCKET_LIMIT = 180;
/** Hard cap on pages to prevent an unbounded loop; exceeding it is an error. */
const DEFAULT_MAX_PAGES = 100;

export type OpenAiAdminClientOptions = {
  /** Org Admin key (`sk-admin…`). Sent only as the Authorization Bearer token. */
  apiKey: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: AdminFetchLike;
  /** Pagination safety cap (default 100). */
  maxPages?: number;
};

export type OpenAiCostsQuery = {
  /** Inclusive lower bound as Unix epoch SECONDS. */
  startTime: number;
  /** Exclusive upper bound as Unix epoch seconds. Optional. */
  endTime?: number;
};

export class OpenAiAdminClient {
  private readonly apiKey: string;
  private readonly fetchImpl: AdminFetchLike;
  private readonly maxPages: number;

  constructor(options: OpenAiAdminClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("OpenAI admin key is required");
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? DEFAULT_ADMIN_FETCH;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * Fetch the org costs for the window, following pagination. Returns one
   * VendorBilledEntry per day (model: null — see the day-grain note above).
   */
  async fetchCosts(query: OpenAiCostsQuery): Promise<VendorBilledEntry[]> {
    if (!Number.isFinite(query.startTime)) {
      throw new Error("OpenAI costs: startTime must be Unix epoch seconds");
    }
    const entries: VendorBilledEntry[] = [];
    let page: string | undefined;
    for (let pageCount = 0; pageCount < this.maxPages; pageCount += 1) {
      const url = this.buildUrl(query, page);
      assertAllowedAdminHost(url, OPENAI_API_HOST);
      const payload = await requestAdminJson(
        url,
        { authorization: `Bearer ${this.apiKey}` },
        this.fetchImpl,
        "OpenAI"
      );
      const parsed = parseCostsPage(payload);
      entries.push(...parsed.entries);
      if (!parsed.hasMore) {
        return entries;
      }
      // has_more is true: a missing/non-string cursor means we cannot fetch the
      // rest, so returning now would silently understate the bill. Fail loud on
      // the malformed (untrusted) payload instead.
      if (!parsed.nextPage) {
        throw new Error(
          "OpenAI costs claimed more pages (has_more) but returned no page cursor; aborting to avoid a partial (understated) bill"
        );
      }
      page = parsed.nextPage;
    }
    throw new Error(
      "OpenAI costs exceeded the page cap; aborting to avoid a partial (understated) bill"
    );
  }

  private buildUrl(query: OpenAiCostsQuery, page?: string): string {
    const url = new URL(COSTS_URL);
    url.searchParams.set("start_time", String(Math.trunc(query.startTime)));
    if (query.endTime !== undefined) {
      url.searchParams.set("end_time", String(Math.trunc(query.endTime)));
    }
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", String(BUCKET_LIMIT));
    if (page) {
      url.searchParams.set("page", page);
    }
    return url.toString();
  }
}

/** Parse one costs page into normalized day-grain entries; strict about money. */
function parseCostsPage(payload: unknown): ParsedBillingPage {
  const root = asRecord(payload);
  if (!(root && Array.isArray(root.data))) {
    throw new Error("OpenAI costs: malformed response (missing data[])");
  }
  const entries: VendorBilledEntry[] = [];
  for (const bucketRaw of root.data) {
    const bucket = asRecord(bucketRaw);
    if (!bucket) {
      throw new Error("OpenAI costs: malformed time bucket");
    }
    const day = utcDayFromUnixSeconds(bucket.start_time, "OpenAI");
    if (!Array.isArray(bucket.results)) {
      throw new Error("OpenAI costs: time bucket missing results[]");
    }
    for (const resultRaw of bucket.results) {
      const result = asRecord(resultRaw);
      if (!result) {
        throw new Error("OpenAI costs: malformed result row");
      }
      const amount = asRecord(result.amount);
      if (
        !amount ||
        typeof amount.value !== "number" ||
        !Number.isFinite(amount.value)
      ) {
        throw new Error("OpenAI costs: result amount.value must be a number");
      }
      const amountMicroCents = usdToMicroCents(amount.value);
      const label =
        typeof result.line_item === "string" ? result.line_item : null;
      entries.push({ day, model: null, amountMicroCents, label });
    }
  }
  return {
    entries,
    hasMore: root.has_more === true,
    nextPage: typeof root.next_page === "string" ? root.next_page : null,
  };
}
