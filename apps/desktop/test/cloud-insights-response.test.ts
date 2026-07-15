import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsGitHubProvenanceState,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import {
  buildUnavailableCloudInsightsResponse,
  fetchCloudInsights,
  isCloudInsightsResponse,
} from "../src/main/cloud-insights-response.js";

const originalFetch = globalThis.fetch;

describe("isCloudInsightsResponse", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts delivery cloud payloads with tile availability proof", () => {
    assert.equal(
      isCloudInsightsResponse(InsightsSection.Delivery, {
        githubProvenance: activeGitHubProvenance(),
        kpis: [],
        tileAvailability: {
          "kpi:merged": InsightsTileAvailabilityState.Available,
        },
        charts: {},
      }),
      true
    );
  });

  it("accepts old delivery cloud payloads that omit tile availability proof", () => {
    assert.equal(
      isCloudInsightsResponse(InsightsSection.Delivery, {
        kpis: [],
        githubProvenance: activeGitHubProvenance(),
        charts: {},
      }),
      true
    );
  });

  it("accepts delivery cloud payloads that omit active GitHub provenance", () => {
    assert.equal(
      isCloudInsightsResponse(InsightsSection.Delivery, {
        kpis: [],
        tileAvailability: {
          "kpi:merged": InsightsTileAvailabilityState.Available,
        },
        charts: {},
      }),
      true
    );
  });

  it("accepts disconnected GitHub provenance for renderer-side gating", () => {
    assert.equal(
      isCloudInsightsResponse(InsightsSection.Delivery, {
        kpis: [],
        githubProvenance: {
          checkedAt: "2026-07-06T00:00:00.000Z",
          state: InsightsGitHubProvenanceState.Disconnected,
        },
        tileAvailability: {
          "kpi:merged": InsightsTileAvailabilityState.Available,
        },
        charts: {},
      }),
      true
    );
  });

  it("rejects unknown availability states", () => {
    assert.equal(
      isCloudInsightsResponse(InsightsSection.Delivery, {
        kpis: [],
        githubProvenance: activeGitHubProvenance(),
        tileAvailability: {
          "kpi:merged": "fresh",
        },
        charts: {},
      }),
      false
    );
  });

  it("keeps agents payloads compatible because agents has no GitHub-truth launch tiles", () => {
    assert.equal(
      isCloudInsightsResponse(InsightsSection.Agents, {
        kpis: [],
        charts: {},
      }),
      true
    );
  });

  it("returns null for malformed cloud JSON instead of throwing", async () => {
    globalThis.fetch = async () =>
      new Response("not-json", {
        headers: { "content-type": "application/json" },
        status: 200,
      });

    const result = await fetchCloudInsights(
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      cloudFetchOptions()
    );

    assert.equal(result, null);
  });

  it("returns null for rejected cloud fetches instead of throwing", async () => {
    globalThis.fetch = () => Promise.reject(new Error("network unavailable"));

    const result = await fetchCloudInsights(
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      cloudFetchOptions()
    );

    assert.equal(result, null);
  });

  it("returns null for malformed cloud origins instead of throwing", async () => {
    const result = await fetchCloudInsights(
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      {
        getApiKey: () => "api-key",
        getApiOrigin: () => "not a url",
      }
    );

    assert.equal(result, null);
  });

  it("returns active-provenance cloud payloads from the org Insights endpoint", async () => {
    let requestedUrl: URL | null = null;
    let authorization: string | null = null;
    globalThis.fetch = (input, init) => {
      requestedUrl = new URL(String(input));
      authorization = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            kpis: [],
            githubProvenance: activeGitHubProvenance(),
            tileAvailability: {
              "kpi:merged": InsightsTileAvailabilityState.Available,
            },
            charts: {},
          },
        })
      );
    };

    const result = await fetchCloudInsights(
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      cloudFetchOptions()
    );

    assert.notEqual(result, null);
    assert.equal(requestedUrl?.pathname, "/insights/delivery");
    assert.equal(requestedUrl?.searchParams.get("scope"), "org");
    assert.equal(authorization, "Bearer api-key");
  });

  it("returns null for raw unwrapped payloads from the org Insights endpoint", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          kpis: [],
          githubProvenance: activeGitHubProvenance(),
          tileAvailability: {
            "kpi:merged": InsightsTileAvailabilityState.Available,
          },
          charts: {},
        })
      );

    const result = await fetchCloudInsights(
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      cloudFetchOptions()
    );

    assert.equal(result, null);
  });

  it("builds gated org responses when cloud data is unavailable", () => {
    const response = buildUnavailableCloudInsightsResponse(
      InsightsSection.Utilization
    );

    assert.deepEqual(response.kpis, []);
    assert.equal("reviewQueue" in response.charts, true);
    if (!("reviewQueue" in response.charts)) {
      assert.fail("expected utilization review queue chart");
    }
    assert.deepEqual(response.charts.reviewQueue, []);
    assert.equal(
      response.tileAvailability?.["chart:reviewQueue"],
      InsightsTileAvailabilityState.Gated
    );
    assert.equal("githubProvenance" in response, true);
    if (!("githubProvenance" in response)) {
      assert.fail("expected utilization GitHub provenance");
    }
    assert.equal(
      response.githubProvenance?.state,
      InsightsGitHubProvenanceState.Disconnected
    );
  });
});

function activeGitHubProvenance() {
  return {
    checkedAt: "2026-07-06T00:00:00.000Z",
    state: InsightsGitHubProvenanceState.Active,
  };
}

function cloudFetchOptions() {
  return {
    getApiKey: () => "api-key",
    getApiOrigin: () => "https://api.example.test",
  };
}
