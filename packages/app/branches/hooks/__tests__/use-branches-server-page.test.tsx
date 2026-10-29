import type { BranchAnalytics } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_FIXTURE,
  legacyServerPageList,
  renderServerPageProbe,
  serverPageList,
  spyingSource,
} from "./server-page-test-utils";

const SERVER_PAGE_FILTERS = {
  pageMode: BranchListPageMode.Server,
  limit: BRANCH_LIST_SERVER_PAGE_SIZE,
  offset: 0,
};

describe("useBranchesPageData server-page staging", () => {
  it("renders server-page list rows before staged analytics settles", async () => {
    let resolveAnalytics: ((value: BranchAnalytics) => void) | undefined;
    const analyticsPending = new Promise<BranchAnalytics>((resolve) => {
      resolveAnalytics = resolve;
    });
    const source = spyingSource("http-staged-analytics");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue(serverPageList("server-page-branch"));
    source.analyticsSpy.mockReturnValue(analyticsPending);

    renderServerPageProbe(source, true);

    await waitFor(() =>
      expect(screen.getByTestId("server-page-row")).toHaveTextContent(
        "server-page-branch"
      )
    );
    expect(source.pageDataSpy).not.toHaveBeenCalled();
    // ISS-10350: the list read carries no clock. The whole request is the
    // filters the reader chose, exactly as a Sessions list read is.
    expect(source.listSpy).toHaveBeenCalledWith(SERVER_PAGE_FILTERS);
    await waitFor(
      () =>
        expect(source.analyticsSpy).toHaveBeenCalledWith({
          pageMode: BranchListPageMode.Server,
        }),
      { timeout: 1000 }
    );
    expect(screen.getByTestId("server-page-analytics")).toHaveTextContent(
      "analytics:pending"
    );

    resolveAnalytics?.(ANALYTICS_FIXTURE);
  });

  it("reads the list even when the producer states no status ordering", async () => {
    const source = spyingSource("http-ordering-unavailable");
    source.supportsSplitPageData = true;
    source.listStatusOrderingSpy.mockResolvedValue(null);
    source.listSpy.mockResolvedValue(serverPageList("server-page-branch"));
    source.analyticsSpy.mockResolvedValue(ANALYTICS_FIXTURE);

    renderServerPageProbe(source);

    await waitFor(() =>
      expect(screen.getByTestId("server-page-row")).toHaveTextContent(
        "server-page-branch"
      )
    );
    expect(source.listSpy).toHaveBeenCalledWith(SERVER_PAGE_FILTERS);
  });

  it("reuses the served status ordering across same-filter remounts", async () => {
    const source = spyingSource("http-ordering-cache");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue(serverPageList("server-page-branch"));
    source.analyticsSpy.mockResolvedValue(ANALYTICS_FIXTURE);

    const firstRender = renderServerPageProbe(source);

    await waitFor(() =>
      expect(screen.getByTestId("server-page-row")).toHaveTextContent(
        "server-page-branch"
      )
    );
    firstRender.unmount();

    renderServerPageProbe(source);

    await waitFor(() =>
      expect(screen.getByTestId("server-page-row")).toHaveTextContent(
        "server-page-branch"
      )
    );
    expect(source.listStatusOrderingSpy).toHaveBeenCalledTimes(1);
    expect(source.listSpy).toHaveBeenCalledWith(SERVER_PAGE_FILTERS);
  });

  it("suppresses staged analytics after a server-page list legacy fallback", async () => {
    const source = spyingSource("http-legacy-fallback");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue(legacyServerPageList("legacy-branch"));
    source.analyticsSpy.mockResolvedValue(ANALYTICS_FIXTURE);

    renderServerPageProbe(source);

    await waitFor(() =>
      expect(screen.getByTestId("server-page-row")).toHaveTextContent(
        "legacy-branch"
      )
    );
    await waitFor(() => expect(source.analyticsSpy).toHaveBeenCalledWith({}));
    // The legacy fallback's own unfiltered read is what SETTLES the analytics
    // query. A server-shaped read is dispatched first and always was —
    // `evaluationNow` used to be the only thing that made the two tellable
    // apart, so asserting the server shape never happens would over-claim.
    expect(source.analyticsSpy).toHaveBeenLastCalledWith({});
  });
});
