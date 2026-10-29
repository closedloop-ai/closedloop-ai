import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sessionAnalyticsKeys,
  useLostWorkInsights,
} from "../use-session-analytics";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const mockResolveBrowserTimeZone = vi.fn();

vi.mock("@repo/app/shared/lib/browser-time-zone", () => ({
  resolveBrowserTimeZone: () => mockResolveBrowserTimeZone(),
}));

describe("sessionAnalyticsKeys", () => {
  it("builds the lost-work query key from period and scope", () => {
    expect(
      sessionAnalyticsKeys.lostWork(InsightsPeriod.Week, InsightsScope.Me)
    ).toEqual(["session-analytics", "lost-work", "7", "me"]);
  });

  it("builds the tokenops-waste query key from period and scope", () => {
    expect(
      sessionAnalyticsKeys.tokenOpsWaste(
        InsightsPeriod.Month,
        InsightsScope.Org
      )
    ).toEqual(["session-analytics", "tokenops-waste", "30", "org"]);
  });
});

describe("useLostWorkInsights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends the resolved browser time zone to the request path", async () => {
    mockResolveBrowserTimeZone.mockReturnValue("America/New_York");
    mockApiClient.get.mockResolvedValueOnce({ unavailableWidgets: [] });

    const { result } = renderHook(
      () => useLostWorkInsights(InsightsPeriod.Week, InsightsScope.Me),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/insights/lost-work?period=7&scope=me&timeZone=America%2FNew_York"
    );
  });

  it("omits the timeZone param when the browser cannot resolve one", async () => {
    mockResolveBrowserTimeZone.mockReturnValue(undefined);
    mockApiClient.get.mockResolvedValueOnce({ unavailableWidgets: [] });

    const { result } = renderHook(
      () => useLostWorkInsights(InsightsPeriod.Week, InsightsScope.Me),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/insights/lost-work?period=7&scope=me"
    );
  });
});
