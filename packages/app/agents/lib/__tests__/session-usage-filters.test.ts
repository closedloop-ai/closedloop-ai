import { DEFAULT_SESSION_QUALITY } from "@repo/api/src/agent-session-filters";
import { describe, expect, it } from "vitest";
import { buildSessionSummaryUsageFilters } from "../session-usage-filters";

const EMPTY_FACETS = {
  statuses: [],
  userIds: [],
  repositories: [],
  harnesses: [],
  models: [],
  autonomyTiers: [],
  costBuckets: [],
  changePresence: [],
  prAssociation: [],
};

describe("buildSessionSummaryUsageFilters", () => {
  // FEA-4177 dedupe: on the no-facet / all-quality path the summary usage read
  // must describe the SAME scope as the facet-option read so React Query hashes
  // them to one key and issues a single request.
  it("normalizes the no-facet all-quality scope to the facet-option scope", () => {
    const summary = buildSessionSummaryUsageFilters({
      endDate: "2026-07-30T23:59:59.999Z",
      startDate: "2026-07-01T00:00:00.000Z",
      userId: "u1",
      quality: DEFAULT_SESSION_QUALITY,
      ...EMPTY_FACETS,
    });

    // Deep-equals the facet-option read's bounded scope — no empty facet arrays
    // or default-quality param — so the two share one cache entry.
    expect(summary).toEqual({
      endDate: "2026-07-30T23:59:59.999Z",
      startDate: "2026-07-01T00:00:00.000Z",
      userId: "u1",
    });
  });

  it("keeps a non-default quality so the summary narrows with the segment", () => {
    const summary = buildSessionSummaryUsageFilters({
      startDate: "2026-07-01T00:00:00.000Z",
      quality: "substantive",
      ...EMPTY_FACETS,
    });

    expect(summary).toEqual({
      startDate: "2026-07-01T00:00:00.000Z",
      quality: "substantive",
    });
  });

  it("carries active facets and drops the empty ones", () => {
    const summary = buildSessionSummaryUsageFilters({
      startDate: "2026-07-01T00:00:00.000Z",
      quality: DEFAULT_SESSION_QUALITY,
      ...EMPTY_FACETS,
      statuses: ["completed"],
      repositories: ["acme/web"],
    });

    expect(summary).toEqual({
      startDate: "2026-07-01T00:00:00.000Z",
      statuses: ["completed"],
      repositories: ["acme/web"],
    });
  });
});
