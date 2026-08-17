import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PenseroMetric } from "../normalization";
import {
  fetchDeliveryMetrics,
  parseDeliveryMetricsPage,
} from "../pensero-client";

const ORIGINAL_TOKEN = process.env.PENSERO_API_TOKEN;
const ORIGINAL_BASE = process.env.PENSERO_API_BASE_URL;

const NOT_CONFIGURED_RE = /Pensero integration not configured/;
const FAILED_401_RE = /failed: 401/;
const QUERY_OR_FRAGMENT_RE = /query string or fragment/;
const EXCEEDED_MAX_PAGES_RE = /exceeded maxPages/;
const ABORT_RE = /Abort/;
const TIMEOUT_RE = /Timed out|Timeout|abort/i;
// Match the real credential shape: tk_<20+> or sk_<20+>. Test fixtures use the
// short "tk_test"/"sk_test" placeholders, which must NOT match.
const SECRET_LIKE_RE = /(?:tk|sk)_[A-Za-z0-9]{20,}/;

/**
 * Collect every string/template-literal text value in a source file via the
 * TypeScript AST. AST-based (not raw-text) so it inspects only real string
 * values — a `tk_...`-shaped literal committed as a credential fails, while
 * the token being named in a comment or docstring does not. This is the
 * sanctioned mechanism for the "no committed secret" invariant (AGENTS.md:
 * source-text regex guards are banned; AST assertions are allowed).
 */
function collectStringLiteralValues(sourcePath: string): string[] {
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      values.push(node.head.text);
      for (const span of node.templateSpans) {
        values.push(span.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function restoreEnv() {
  if (ORIGINAL_TOKEN === undefined) {
    Reflect.deleteProperty(process.env, "PENSERO_API_TOKEN");
  } else {
    process.env.PENSERO_API_TOKEN = ORIGINAL_TOKEN;
  }
  if (ORIGINAL_BASE === undefined) {
    Reflect.deleteProperty(process.env, "PENSERO_API_BASE_URL");
  } else {
    process.env.PENSERO_API_BASE_URL = ORIGINAL_BASE;
  }
}

describe("parseDeliveryMetricsPage (external boundary)", () => {
  it("validates a well-formed page and maps snake_case wire keys", () => {
    const { records, next } = parseDeliveryMetricsPage({
      results: [
        {
          person_id: "p1",
          pr_id: "pr-1",
          metrics: { [PenseroMetric.MergedPullRequests]: 2 },
        },
      ],
      next: null,
    });
    expect(next).toBeNull();
    expect(records[0]).toMatchObject({
      personId: "p1",
      prId: "pr-1",
      metrics: { [PenseroMetric.MergedPullRequests]: 2 },
    });
  });

  it("strips unknown Pensero metrics instead of rejecting the record", () => {
    const { records } = parseDeliveryMetricsPage({
      results: [
        {
          person_id: "p1",
          branch_id: "b1",
          metrics: {
            [PenseroMetric.DeliveredFeatures]: 1,
            some_future_metric: 99,
          },
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0].metrics).toEqual({
      [PenseroMetric.DeliveredFeatures]: 1,
    });
  });

  it("rejects a malformed record (missing personId)", () => {
    expect(() =>
      parseDeliveryMetricsPage({ results: [{ metrics: {} }] })
    ).toThrow();
  });

  it("rejects a non-finite metric value", () => {
    expect(() =>
      parseDeliveryMetricsPage({
        results: [
          {
            person_id: "p1",
            pr_id: "pr-1",
            metrics: { [PenseroMetric.MergedPullRequests]: Number.NaN },
          },
        ],
      })
    ).toThrow();
  });

  it("rejects a negative count metric", () => {
    expect(() =>
      parseDeliveryMetricsPage({
        results: [
          {
            person_id: "p1",
            pr_id: "pr-1",
            metrics: { [PenseroMetric.MergedPullRequests]: -3 },
          },
        ],
      })
    ).toThrow();
  });

  it("rejects a non-integer count metric", () => {
    expect(() =>
      parseDeliveryMetricsPage({
        results: [
          {
            person_id: "p1",
            branch_id: "b1",
            metrics: { [PenseroMetric.DeliveredFeatures]: 1.5 },
          },
        ],
      })
    ).toThrow();
  });

  it("rejects an out-of-range quality score (> 1)", () => {
    expect(() =>
      parseDeliveryMetricsPage({
        results: [
          {
            person_id: "p1",
            pr_id: "pr-1",
            metrics: { [PenseroMetric.ReviewThoroughness]: 1.4 },
          },
        ],
      })
    ).toThrow();
  });

  it("rejects a negative quality score (< 0)", () => {
    expect(() =>
      parseDeliveryMetricsPage({
        results: [
          {
            person_id: "p1",
            branch_id: "b1",
            metrics: { [PenseroMetric.DefectFreedom]: -0.1 },
          },
        ],
      })
    ).toThrow();
  });

  it("rejects a negative duration metric", () => {
    expect(() =>
      parseDeliveryMetricsPage({
        results: [
          {
            person_id: "p1",
            session_id: "s1",
            metrics: { [PenseroMetric.CycleTimeHours]: -2 },
          },
        ],
      })
    ).toThrow();
  });

  it("accepts a valid fractional duration and 0..1 score", () => {
    const { records } = parseDeliveryMetricsPage({
      results: [
        {
          person_id: "p1",
          session_id: "s1",
          pr_id: "pr-1",
          metrics: {
            [PenseroMetric.CycleTimeHours]: 3.75,
            [PenseroMetric.ReviewThoroughness]: 0.5,
          },
        },
      ],
    });
    expect(records[0].metrics).toEqual({
      [PenseroMetric.CycleTimeHours]: 3.75,
      [PenseroMetric.ReviewThoroughness]: 0.5,
    });
  });
});

describe("fetchDeliveryMetrics (env credentials)", () => {
  beforeEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("throws a clear error when PENSERO_API_TOKEN is unset", async () => {
    Reflect.deleteProperty(process.env, "PENSERO_API_TOKEN");
    await expect(fetchDeliveryMetrics()).rejects.toThrow(NOT_CONFIGURED_RE);
  });

  it("sends the env token as a DRF Token auth header (never hardcoded)", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], next: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDeliveryMetrics();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://example.test/api/delivery-metrics/");
    expect(init?.headers).toMatchObject({
      Authorization: "Token tk_test:sk_test",
    });
  });

  it("joins the endpoint with exactly one slash when the base URL has a trailing slash", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    // A trailing slash on the base must NOT produce `/api//delivery-metrics/`.
    process.env.PENSERO_API_BASE_URL = "https://example.test/api/";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], next: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDeliveryMetrics();

    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://example.test/api/delivery-metrics/");
  });

  it("rejects a base URL carrying a query string before any request is made", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api?token=leak";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], next: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDeliveryMetrics()).rejects.toThrow(QUERY_OR_FRAGMENT_RE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a base URL carrying a fragment before any request is made", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api#frag";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], next: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDeliveryMetrics()).rejects.toThrow(QUERY_OR_FRAGMENT_RE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows DRF cursor pagination without truncating", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              person_id: "p1",
              pr_id: "pr-1",
              metrics: { [PenseroMetric.MergedPullRequests]: 1 },
            },
          ],
          next: "https://example.test/api/delivery-metrics/?cursor=2",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              person_id: "p2",
              pr_id: "pr-2",
              metrics: { [PenseroMetric.MergedPullRequests]: 2 },
            },
          ],
          next: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const records = await fetchDeliveryMetrics();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.personId)).toEqual(["p1", "p2"]);
  });

  it("does not follow a cross-origin next cursor (token exfiltration guard)", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({
        results: [
          {
            person_id: "p1",
            pr_id: "pr-1",
            metrics: { [PenseroMetric.MergedPullRequests]: 1 },
          },
        ],
        // A spoofed cursor pointing at another host must NOT receive our
        // Authorization header on a follow-up hop.
        next: "https://evil.example/api/delivery-metrics/?cursor=2",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const records = await fetchDeliveryMetrics();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records.map((r) => r.personId)).toEqual(["p1"]);
  });

  it("throws (not silently truncates) when the page cap is hit with a remaining cursor", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    // Every page keeps returning a same-origin `next`, so the cursor is never
    // exhausted — the cap is the only thing that can stop the loop.
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          {
            person_id: "p1",
            pr_id: "pr-1",
            metrics: { [PenseroMetric.MergedPullRequests]: 1 },
          },
        ],
        next: "https://example.test/api/delivery-metrics/?cursor=next",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDeliveryMetrics({ maxPages: 2 })).rejects.toThrow(
      EXCEEDED_MAX_PAGES_RE
    );
    // The loop stopped at the cap rather than following the cursor forever.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not throw when the cursor is exhausted exactly at the page cap", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          {
            person_id: "p1",
            pr_id: "pr-1",
            metrics: { [PenseroMetric.MergedPullRequests]: 1 },
          },
        ],
        next: null,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const records = await fetchDeliveryMetrics({ maxPages: 1 });
    expect(records.map((r) => r.personId)).toEqual(["p1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal to every page fetch (bounded by a per-request timeout)", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], next: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDeliveryMetrics();

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the in-flight page fetch when the caller's signal fires", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const controller = new AbortController();
    // A stalled page: resolve only when the request signal aborts, mirroring
    // fetch's real behavior so the caller signal is what unblocks the loop.
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchDeliveryMetrics({ signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(ABORT_RE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled page fetch once the per-request timeout elapses", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    process.env.PENSERO_API_BASE_URL = "https://example.test/api";
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Timed out", "TimeoutError"))
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    // A 1ms ceiling: the stalled fetch never resolves on its own, so only the
    // timeout signal can end it.
    await expect(fetchDeliveryMetrics({ requestTimeoutMs: 1 })).rejects.toThrow(
      TIMEOUT_RE
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws without echoing the response body on a non-OK status", async () => {
    process.env.PENSERO_API_TOKEN = "tk_test:sk_test";
    const fetchMock = vi.fn(
      async () => new Response("token=tk_leak:sk_leak", { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDeliveryMetrics()).rejects.toThrow(FAILED_401_RE);
  });
});

describe("no committed secret", () => {
  it("does not hardcode a Pensero tk_/sk_ token literal in any package source string", () => {
    const sources = [
      "../keys.ts",
      "../pensero-client.ts",
      "../normalization.ts",
    ];
    for (const rel of sources) {
      const sourcePath = fileURLToPath(new URL(rel, import.meta.url));
      const literals = collectStringLiteralValues(sourcePath);
      const offending = literals.filter((value) => SECRET_LIKE_RE.test(value));
      expect(offending).toEqual([]);
    }
  });
});
