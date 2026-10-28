import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BranchQueryFilters } from "../../data-source/branches-data-source";
import {
  ANALYTICS_FIXTURE,
  analyticsFixture,
  flushAsyncWork,
  rangeFilters,
  renderServerPagePresentedProbe,
  renderServerPageProbe,
  SEVEN_DAY_START,
  serverPageList,
  serverPagePresentedProbeTree,
  spyingSource,
  THIRTY_DAY_START,
} from "./server-page-test-utils";

const SERVER_PAGE_FILTERS = {
  pageMode: BranchListPageMode.Server,
  limit: BRANCH_LIST_SERVER_PAGE_SIZE,
  offset: 0,
};

describe("useBranchesPageData served-ordering cache", () => {
  it("retries a transient null ordering read after the short retry cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T18:00:00.000Z"));
    const source = spyingSource("http-ordering-retry-null");
    source.supportsSplitPageData = true;
    source.listStatusOrderingSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ statusOrdering: "root_first" });
    source.listSpy.mockResolvedValue(serverPageList("server-page-branch"));
    source.analyticsSpy.mockResolvedValue(ANALYTICS_FIXTURE);
    const rendered = renderServerPageProbe(source);

    try {
      await flushAsyncWork();
      await flushAsyncWork();
      expect(source.listStatusOrderingSpy).toHaveBeenCalledTimes(1);
      expect(source.listSpy).toHaveBeenCalledWith(SERVER_PAGE_FILTERS);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      await flushAsyncWork();
      await flushAsyncWork();

      expect(source.listStatusOrderingSpy).toHaveBeenCalledTimes(2);
      // The list request itself is unchanged by the ordering read — it never
      // carried a producer-issued value in the first place (ISS-10350).
      expect(source.listSpy).toHaveBeenCalledWith(SERVER_PAGE_FILTERS);
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });

  it("withholds uncached switched ranges but reuses an exact loaded range", async () => {
    let nowMs = Date.parse("2026-08-22T18:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const source = spyingSource("http-ordering-range-return");
    source.supportsSplitPageData = true;
    source.listSpy.mockImplementation((filters: BranchQueryFilters) =>
      Promise.resolve(
        serverPageList(
          filters.startDate === SEVEN_DAY_START
            ? "seven-day-branch"
            : "thirty-day-branch"
        )
      )
    );
    source.analyticsSpy.mockImplementation((filters: BranchQueryFilters) =>
      Promise.resolve(
        analyticsFixture(filters.startDate === SEVEN_DAY_START ? 7 : 30)
      )
    );
    const rendered = renderServerPagePresentedProbe(
      source,
      rangeFilters(SEVEN_DAY_START)
    );

    try {
      await waitFor(() =>
        expect(screen.getByTestId("presented-row")).toHaveTextContent(
          "seven-day-branch"
        )
      );
      await waitFor(() =>
        expect(screen.getByTestId("presented-active-count")).toHaveTextContent(
          "7"
        )
      );

      nowMs += 6000;
      rendered.rerender(
        serverPagePresentedProbeTree(source, rangeFilters(THIRTY_DAY_START))
      );

      expect(screen.getByTestId("presented-row")).toHaveTextContent("none");
      expect(screen.getByTestId("presented-active-count")).toHaveTextContent(
        "none"
      );

      await waitFor(() =>
        expect(screen.getByTestId("presented-row")).toHaveTextContent(
          "thirty-day-branch"
        )
      );
      await waitFor(() =>
        expect(screen.getByTestId("presented-active-count")).toHaveTextContent(
          "30"
        )
      );

      source.listSpy.mockClear();
      source.analyticsSpy.mockClear();
      nowMs += 6000;
      rendered.rerender(
        serverPagePresentedProbeTree(source, rangeFilters(SEVEN_DAY_START))
      );

      expect(source.listSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId("presented-row")).toHaveTextContent(
        "seven-day-branch"
      );
      expect(source.analyticsSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId("presented-active-count")).toHaveTextContent(
        "7"
      );
    } finally {
      rendered.unmount();
      nowSpy.mockRestore();
    }
  });

  it("anchors cached ordering reuse to the original producer read time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T18:00:00.000Z"));
    const source = spyingSource("http-ordering-reused-renewal");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue(serverPageList("server-page-branch"));
    source.analyticsSpy.mockResolvedValue(ANALYTICS_FIXTURE);
    const firstRender = renderServerPageProbe(source);
    let secondRender: ReturnType<typeof renderServerPageProbe> | undefined;

    try {
      await flushAsyncWork();
      await flushAsyncWork();
      firstRender.unmount();
      const callsAfterInitialRead =
        source.listStatusOrderingSpy.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      secondRender = renderServerPageProbe(source);
      await flushAsyncWork();
      await flushAsyncWork();
      // Reuse is anchored to the FIRST read, not to this mount.
      expect(source.listStatusOrderingSpy.mock.calls.length).toBe(
        callsAfterInitialRead
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60 * 1000 - 6000);
      });
      await flushAsyncWork();
      await flushAsyncWork();

      expect(source.listStatusOrderingSpy.mock.calls.length).toBeGreaterThan(
        callsAfterInitialRead
      );
    } finally {
      secondRender?.unmount();
      vi.useRealTimers();
    }
  });
});
