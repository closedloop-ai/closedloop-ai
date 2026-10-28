import type { UtilizationInsightsResponse } from "@repo/api/src/types/insights";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLocalWindowSessionVerdict } from "../dashboard-range-verdict";

const WEEK = "7";

function payload(sessions: number): UtilizationInsightsResponse {
  return {
    charts: {},
    kpis: [{ key: InsightsKpiKey.Sessions, value: sessions }],
  } as unknown as UtilizationInsightsResponse;
}

function utilizationQuery(cached: number, reread: number) {
  return {
    data: payload(cached),
    isPlaceholderData: false,
    refetch: vi.fn(() =>
      Promise.resolve({ isSuccess: true, data: payload(reread) })
    ),
  };
}

type Props = {
  enabled: boolean;
  allTime: number;
  query: ReturnType<typeof utilizationQuery>;
  sessionsTotal: number;
};

function renderVerdict(initial: Props) {
  const readAllTime = vi.fn((count: number) => Promise.resolve(payload(count)));
  const rendered = renderHook(
    ({ enabled, allTime, query, sessionsTotal }: Props) =>
      useLocalWindowSessionVerdict({
        enabled,
        period: WEEK,
        readAllTime: () => readAllTime(allTime),
        sessionsTotal,
        // The hook reads only these fields; the full observer result is not
        // needed to exercise it.
        utilization: query as unknown as Parameters<
          typeof useLocalWindowSessionVerdict
        >[0]["utilization"],
      }),
    { initialProps: initial }
  );
  return { ...rendered, readAllTime };
}

describe("useLocalWindowSessionVerdict (ISS-11927 settled zero)", () => {
  it("withholds a cached zero until the paired re-read answers", async () => {
    const query = utilizationQuery(0, 0);
    const { result, readAllTime } = renderVerdict({
      enabled: true,
      allTime: 4,
      query,
      sessionsTotal: 4,
    });

    expect(result.current.windowSessionCount).toBeNull();
    await waitFor(() =>
      expect(result.current).toEqual({
        windowSessionCount: 0,
        hasSessionsOutsideWindow: true,
      })
    );
    expect(readAllTime).toHaveBeenCalledTimes(1);
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it("finds nothing outside the window when the windowed cohort is empty over all time", async () => {
    // The ISS-11927 e2e race: the session list already counts a session the
    // windowed cohort cannot place yet, so the list total is no evidence.
    const { result } = renderVerdict({
      enabled: true,
      allTime: 0,
      query: utilizationQuery(0, 0),
      sessionsTotal: 1,
    });

    await waitFor(() =>
      expect(result.current.hasSessionsOutsideWindow).toBe(false)
    );
  });

  it("re-reads again when the session count moves", async () => {
    const query = utilizationQuery(0, 0);
    const { result, rerender } = renderVerdict({
      enabled: true,
      allTime: 1,
      query,
      sessionsTotal: 1,
    });
    await waitFor(() => expect(result.current.windowSessionCount).toBe(0));

    rerender({ enabled: true, allTime: 2, query, sessionsTotal: 2 });

    expect(result.current.windowSessionCount).toBeNull();
    await waitFor(() => expect(query.refetch).toHaveBeenCalledTimes(2));
  });

  it("passes the cached count through, without a re-read, when not needed", () => {
    const disabled = utilizationQuery(0, 0);
    const { result: off } = renderVerdict({
      enabled: false,
      allTime: 1,
      query: disabled,
      sessionsTotal: 1,
    });
    expect(off.current).toEqual({
      windowSessionCount: 0,
      hasSessionsOutsideWindow: null,
    });
    expect(disabled.refetch).not.toHaveBeenCalled();

    const nonZero = utilizationQuery(3, 3);
    const { result: on } = renderVerdict({
      enabled: true,
      allTime: 3,
      query: nonZero,
      sessionsTotal: 3,
    });
    expect(on.current.windowSessionCount).toBe(3);
    expect(nonZero.refetch).not.toHaveBeenCalled();
  });
});
