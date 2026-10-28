import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import { describe, expect, it } from "vitest";
import {
  FIRST_TOKEN_TREND_PAGE,
  isRepeatedCursor,
  mergeTokenTrendPages,
  nextTokenTrendPageParam,
  type TokenTrendPageParam,
  type TokenTrendPageRequest,
} from "../token-trend-pages";

/**
 * ISS-9851 — the next-page derivation and the merge, without a query client.
 *
 * The derivation's contract is that every follow-up request replays PAGE ONE's
 * window: an absent `since` is defaulted by the server against its own clock,
 * so a later page's own window (or no window at all) would slide the range
 * forward mid-walk and the merged trend would cover a range no single read ever
 * did. The merge's contract is that the pages come back in the order ONE unpaged
 * read would have produced — which is why the tie case below deliberately puts
 * the smaller session id on the LATER page.
 */

const SLUG = "skill::rtk";
const SINCE = "2026-06-08T12:00:00.000Z";
const UNTIL = "2026-09-06T12:00:00.000Z";
// A window a LATER page reports. Nothing in a correct walk may ever send it.
const LATER_PAGE_SINCE = "2026-01-01T00:00:00.000Z";

function point(
  sessionId: string,
  sessionStartedAt: string,
  model: string
): TokenTrendPoint {
  return {
    sessionId,
    sessionStartedAt,
    model,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0.1,
    runtimeMs: 1000,
    componentInvocations: 1,
    componentErrorCount: 0,
  };
}

function page(overrides: Partial<TokenTrendResponse>): TokenTrendResponse {
  return { slug: SLUG, points: [], models: [], ...overrides };
}

describe("nextTokenTrendPageParam", () => {
  it("ends the walk on a page that offers no cursor", () => {
    const only = page({
      appliedWindow: { since: SINCE },
      points: [point("s1", SINCE, "opus")],
    });

    expect(nextTokenTrendPageParam(only, only, [FIRST_TOKEN_TREND_PAGE])).toBe(
      undefined
    );
  });

  it("replays PAGE ONE's window on every follow-up, with the page in hand's cursor", () => {
    const first = page({
      appliedWindow: { since: SINCE, until: UNTIL },
      nextCursor: "c1",
    });
    // The later page states a DIFFERENT window. A walk that re-pinned from the
    // page in hand would send `LATER_PAGE_SINCE` on the third request.
    const second = page({
      appliedWindow: { since: LATER_PAGE_SINCE },
      nextCursor: "c2",
    });

    expect(
      nextTokenTrendPageParam(first, first, [FIRST_TOKEN_TREND_PAGE])
    ).toEqual({ cursor: "c1", since: SINCE, until: UNTIL });
    expect(
      nextTokenTrendPageParam(second, first, [
        FIRST_TOKEN_TREND_PAGE,
        { cursor: "c1", since: SINCE, until: UNTIL },
      ])
    ).toEqual({ cursor: "c2", since: SINCE, until: UNTIL });
  });

  it("omits `until` entirely when the applied window was unbounded above", () => {
    const first = page({ appliedWindow: { since: SINCE }, nextCursor: "c1" });

    const followUp = nextTokenTrendPageParam(first, first, [
      FIRST_TOKEN_TREND_PAGE,
    ]) as TokenTrendPageRequest;

    expect(followUp).toEqual({ cursor: "c1", since: SINCE });
    // Not merely undefined: an `until=undefined` key still reaches the request
    // builder, and a producer that reads keys rather than values would see a
    // bound the read never applied.
    expect(Object.hasOwn(followUp, "until")).toBe(false);
  });

  it("stops at a page that offers a cursor but no window to pin", () => {
    const unfollowable = page({ nextCursor: "c1", truncated: true });

    expect(
      nextTokenTrendPageParam(unfollowable, unfollowable, [
        FIRST_TOKEN_TREND_PAGE,
      ])
    ).toBe(undefined);
  });

  it("refuses a position already read instead of requesting it again", () => {
    const first = page({ appliedWindow: { since: SINCE }, nextCursor: "c1" });
    const looping = page({
      appliedWindow: { since: SINCE },
      nextCursor: "c1",
    });

    const refusal = nextTokenTrendPageParam(looping, first, [
      FIRST_TOKEN_TREND_PAGE,
      { cursor: "c1", since: SINCE },
    ]);

    expect(refusal).toEqual({ repeatedCursor: "c1" });
    expect(isRepeatedCursor(refusal as TokenTrendPageParam)).toBe(true);
    // The request form is what the hook sends; the refusal is what it throws on.
    expect(isRepeatedCursor({ cursor: "c1", since: SINCE })).toBe(false);
  });
});

describe("mergeTokenTrendPages", () => {
  it("orders every page's points ascending by session start", () => {
    const pages: TokenTrendResponse[] = [
      page({ points: [point("s3", "2026-08-03T00:00:00.000Z", "opus")] }),
      page({
        points: [
          point("s1", "2026-08-01T00:00:00.000Z", "opus"),
          point("s2", "2026-08-02T00:00:00.000Z", "opus"),
        ],
      }),
    ];

    const merged = mergeTokenTrendPages(pages);

    expect(merged.points.map((p) => p.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(merged.slug).toBe(SLUG);
  });

  // The one an order-blind merge fails. The server reads `sessionStartedAt`
  // DESC, `agentSessionId` ASC, so on a shared instant the smaller id is the
  // earlier row — and the paged read hands it back on the LATER page. Trusting
  // page order here would order a split trend opposite to an unpaged read of the
  // very same data.
  it("breaks a shared session start on session id, not on which page carried it", () => {
    const shared = "2026-08-05T00:00:00.000Z";
    const pages: TokenTrendResponse[] = [
      page({ points: [point("sess-b", shared, "opus")] }),
      page({ points: [point("sess-a", shared, "opus")] }),
    ];

    const merged = mergeTokenTrendPages(pages);

    expect(merged.points.map((p) => p.sessionId)).toEqual(["sess-a", "sess-b"]);
  });

  it("keeps one session's per-model points in the order the page listed them", () => {
    const at = "2026-08-06T00:00:00.000Z";
    const pages: TokenTrendResponse[] = [
      page({
        points: [
          point("s1", at, "sonnet"),
          point("s1", at, "haiku"),
          point("s1", at, "opus"),
        ],
      }),
    ];

    const merged = mergeTokenTrendPages(pages);

    expect(merged.points.map((p) => p.model)).toEqual([
      "sonnet",
      "haiku",
      "opus",
    ]);
  });

  it("returns the deduped, sorted union of every page's models", () => {
    const pages: TokenTrendResponse[] = [
      page({ models: ["opus", "sonnet"] }),
      page({ models: ["haiku", "opus"] }),
    ];

    expect(mergeTokenTrendPages(pages).models).toEqual([
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  it("takes the window from page one and truncation from the last page alone", () => {
    const pages: TokenTrendResponse[] = [
      // Page one said "truncated" only to mean more pages followed — and the
      // walk then read them, so that disclosure must not survive the merge.
      page({
        appliedWindow: { since: SINCE, until: UNTIL },
        truncated: true,
        nextCursor: "c1",
      }),
      page({ appliedWindow: { since: LATER_PAGE_SINCE } }),
    ];

    const merged = mergeTokenTrendPages(pages);

    expect(merged.appliedWindow).toEqual({ since: SINCE, until: UNTIL });
    expect(Object.hasOwn(merged, "truncated")).toBe(false);
  });

  it("carries a last page's own truncation, for a producer that sends one without a cursor", () => {
    const pages: TokenTrendResponse[] = [
      page({ appliedWindow: { since: SINCE }, nextCursor: "c1" }),
      page({ truncated: true }),
    ];

    expect(mergeTokenTrendPages(pages).truncated).toBe(true);
  });

  it("never re-offers a cursor: the merged response is a whole read", () => {
    const pages: TokenTrendResponse[] = [
      page({ nextCursor: "c1" }),
      page({ nextCursor: "c2" }),
    ];

    expect(Object.hasOwn(mergeTokenTrendPages(pages), "nextCursor")).toBe(
      false
    );
  });

  it("states truncation while the last page still offers a cursor", () => {
    // Two walks end here. One is still reading: the chart draws this prefix
    // while the next page loads. The other stopped for good, on a producer that
    // offers a continuation without naming its window — a follow-up with no
    // pinned `since` would slide the range. Either way what is merged is a
    // PREFIX of the window, and it has to say so even though this page never
    // set `truncated` itself.
    const pages: TokenTrendResponse[] = [
      page({ points: [point("s1", SINCE, "opus")], nextCursor: "c1" }),
    ];

    const merged = mergeTokenTrendPages(pages);

    expect(merged.truncated).toBe(true);
    // The continuation is consumed by the walk, never handed to a consumer.
    expect(Object.hasOwn(merged, "nextCursor")).toBe(false);
  });

  it("refuses an empty page set rather than inventing a trend", () => {
    expect(() => mergeTokenTrendPages([])).toThrow(
      "no token-trend page to merge"
    );
  });
});
