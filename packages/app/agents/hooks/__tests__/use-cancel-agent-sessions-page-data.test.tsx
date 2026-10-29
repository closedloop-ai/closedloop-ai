/**
 * @file use-cancel-agent-sessions-page-data.test.tsx
 * @description ISS-7249 (whitlockk review): a Retry against a WEDGED first list read
 * has to start a new request, and `refetch({ cancelRefetch: true })` does not.
 *
 * query-core 5.90.20 only takes the cancel branch when `state.data !== undefined`;
 * on a read that has never answered it calls `continueRetry()` and hands back the
 * existing retryer promise instead. So the Retry awaited the same hung request,
 * no second read ever started, and `retry_settled` never arrived.
 *
 * That is a fact about the LIBRARY, so a mocked query client cannot reproduce it.
 * This drives a real `QueryClient` (via `AppCoreStoryProviders`) and a data source
 * whose first `pageData` call never resolves, and asserts the second request.
 */
import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { AgentSessionsDataSource } from "../../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../../data-source/provider";
import {
  useAgentSessionsPageData,
  useCancelAgentSessionsPageData,
} from "../use-agent-sessions";

const FILTERS = { limit: 25, offset: 0 } as const;

const EMPTY_PAGE_DATA: AgentSessionsPageData = {
  list: {
    items: [],
    total: 0,
    viewerScope: AgentSessionViewerScope.Self,
  },
};

/** A source whose FIRST `pageData` call never settles — the hard stall. */
function wedgingSource(): {
  dataSource: AgentSessionsDataSource;
  calls: number[];
  releaseSecond: () => void;
} {
  const calls: number[] = [];
  let releaseSecond: () => void = () => {
    // Replaced once the SECOND read starts; a press before then releases nothing.
  };
  const dataSource: AgentSessionsDataSource = {
    scope: "wedged",
    list: () => Promise.reject(new Error("list unused")),
    detail: () => Promise.reject(new Error("detail unused")),
    usage: () => Promise.reject(new Error("usage unused")),
    analytics: () => Promise.reject(new Error("analytics unused")),
    pageData: () => {
      calls.push(calls.length + 1);
      if (calls.length === 1) {
        // Never resolves and never rejects: the wedged request.
        return new Promise<AgentSessionsPageData>(() => undefined);
      }
      return new Promise<AgentSessionsPageData>((resolve) => {
        releaseSecond = () => resolve(EMPTY_PAGE_DATA);
      });
    },
  };
  return { calls, dataSource, releaseSecond: () => releaseSecond() };
}

describe("useCancelAgentSessionsPageData", () => {
  it("lets a refetch start a NEW read after a first one that never answered", async () => {
    const source = wedgingSource();
    let retry: () => Promise<unknown> = () => Promise.resolve();
    let settled = false;

    function Probe() {
      const query = useAgentSessionsPageData(FILTERS);
      const cancel = useCancelAgentSessionsPageData(FILTERS);
      retry = () => {
        cancel();
        return query.refetch();
      };
      return null;
    }

    render(
      <AppCoreStoryProviders>
        <AgentSessionsDataSourceProvider dataSource={source.dataSource}>
          <Probe />
        </AgentSessionsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() => expect(source.calls).toEqual([1]));

    await act(async () => {
      retry().then(() => {
        settled = true;
      });
      await Promise.resolve();
    });

    // Without the cancel this stays at one call: query-core returns the wedged
    // retryer's promise and issues no request.
    await waitFor(() => expect(source.calls).toEqual([1, 2]));
    expect(settled).toBe(false);

    // And the retry's own promise settles off the NEW read, which is what makes
    // `retry_settled` reachable at all.
    await act(async () => {
      source.releaseSecond();
      await Promise.resolve();
    });
    await waitFor(() => expect(settled).toBe(true));
  });

  it("cancels only the exact key, leaving another scope's read alone", async () => {
    // `exact: true` matters: the `pageDataRoot` prefix matches every scope and
    // every filter set, so a prefix cancel would abort reads this Retry has no
    // business touching.
    const wedged = wedgingSource();
    const otherCalls: string[] = [];
    const otherSource: AgentSessionsDataSource = {
      ...wedged.dataSource,
      scope: "other",
      pageData: () => {
        otherCalls.push("pageData");
        return new Promise<AgentSessionsPageData>(() => undefined);
      },
    };
    let cancelWedged: () => void = () => undefined;

    function Probe() {
      useAgentSessionsPageData(FILTERS);
      cancelWedged = useCancelAgentSessionsPageData(FILTERS);
      return null;
    }
    function OtherProbe() {
      const query = useAgentSessionsPageData(FILTERS);
      return <span data-testid="other-status">{query.fetchStatus}</span>;
    }

    const view = render(
      <AppCoreStoryProviders>
        <AgentSessionsDataSourceProvider dataSource={wedged.dataSource}>
          <Probe />
        </AgentSessionsDataSourceProvider>
        <AgentSessionsDataSourceProvider dataSource={otherSource}>
          <OtherProbe />
        </AgentSessionsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() => expect(otherCalls).toEqual(["pageData"]));
    expect(view.getByTestId("other-status")).toHaveTextContent("fetching");

    await act(async () => {
      cancelWedged();
      await Promise.resolve();
    });

    // The other scope's read is untouched — still in flight, not aborted.
    expect(view.getByTestId("other-status")).toHaveTextContent("fetching");
  });
});
