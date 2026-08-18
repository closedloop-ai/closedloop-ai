import { describe, expect, it } from "vitest";
import {
  SearchMode,
  searchHitSchema,
  unifiedSearchResponseSchema,
} from "../search";
import { SearchEntityType } from "../search-entity-kind";

const BASE_HIT = {
  entityType: SearchEntityType.Loop,
  entityId: "loop-1",
  title: "Alpha loop",
  snippet: "run the <b>alpha</b> loop",
  rank: 0.5,
  deepLink: "/loops/loop-1",
} as const;

describe("searchHitSchema updatedAt", () => {
  it("accepts a raw ISO string and coerces it to a Date", () => {
    const parsed = searchHitSchema.parse({
      ...BASE_HIT,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.updatedAt).toBeInstanceOf(Date);
    expect(parsed.updatedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts an already-revived Date (the web apiClient revives ISO strings before parse)", () => {
    // `apiClient.get` runs `JSON.parse(..., reviveWithDates)`, so `updatedAt` is
    // a `Date` by the time this schema parses. A bare `z.string()` rejected this
    // and threw on every unified-search response (FEA-3873 review).
    const revived = new Date("2026-01-01T00:00:00.000Z");
    const parsed = searchHitSchema.parse({ ...BASE_HIT, updatedAt: revived });

    expect(parsed.updatedAt).toBeInstanceOf(Date);
    expect(parsed.updatedAt.getTime()).toBe(revived.getTime());
  });
});

describe("unifiedSearchResponseSchema", () => {
  it("parses a full response whose hit dates were revived to Date objects", () => {
    const parsed = unifiedSearchResponseSchema.parse({
      query: "alpha",
      mode: SearchMode.Prefix,
      results: [
        { ...BASE_HIT, updatedAt: new Date("2026-01-01T00:00:00.000Z") },
      ],
      nextCursor: null,
    });

    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
