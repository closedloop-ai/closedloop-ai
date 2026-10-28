import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { AgentSessionsDataSource } from "../../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../../data-source/provider";
import { useAgentSessionEventsPages } from "../use-agent-session-events-pages";

const SESSION_ID = "session-1";
const FIRST_CURSOR = "first";

function source(
  eventsPage: AgentSessionsDataSource["eventsPage"]
): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockRejectedValue(new Error("list unused")),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockRejectedValue(new Error("usage unused")),
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
    pageData: vi.fn().mockRejectedValue(new Error("pageData unused")),
    ...(eventsPage ? { eventsPage } : {}),
  };
}

function createDataSourceWrapper(dataSource: AgentSessionsDataSource) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("useAgentSessionEventsPages (ISS-9857)", () => {
  it("fetches nothing until asked, then follows the cursor and stops without one", async () => {
    const pages: Record<string, AgentSessionEventsPage> = {
      [FIRST_CURSOR]: { events: [], nextCursor: "second" },
      second: { events: [] },
    };
    const eventsPage = vi.fn(
      async (request: { cursor?: string }) =>
        pages[request.cursor ?? ""] ?? { events: [] }
    );
    const { result } = renderHook(
      () =>
        useAgentSessionEventsPages({
          sessionId: SESSION_ID,
          firstCursor: FIRST_CURSOR,
        }),
      { wrapper: createDataSourceWrapper(source(eventsPage)) }
    );

    // Nothing loaded yet is "more to load", never "done".
    expect(result.current.hasMore).toBe(true);
    expect(result.current.pages).toEqual([]);
    expect(eventsPage).not.toHaveBeenCalled();

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pages).toHaveLength(1));
    expect(eventsPage).toHaveBeenLastCalledWith({
      id: SESSION_ID,
      cursor: FIRST_CURSOR,
      limit: undefined,
    });
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pages).toHaveLength(2));
    expect(eventsPage).toHaveBeenLastCalledWith({
      id: SESSION_ID,
      cursor: "second",
      limit: undefined,
    });
    expect(result.current.hasMore).toBe(false);
    expect(eventsPage).toHaveBeenCalledTimes(2);
  });

  it("errors, without retrying, when a producer echoes a cursor already asked for", async () => {
    const eventsPage = vi.fn(
      async (): Promise<AgentSessionEventsPage> => ({
        events: [],
        nextCursor: FIRST_CURSOR,
      })
    );
    const { result } = renderHook(
      () =>
        useAgentSessionEventsPages({
          sessionId: SESSION_ID,
          firstCursor: FIRST_CURSOR,
        }),
      { wrapper: createDataSourceWrapper(source(eventsPage)) }
    );
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pages).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.isError).toBe(true));
    // The echoed cursor was refused before it reached the source.
    expect(eventsPage).toHaveBeenCalledTimes(1);
    expect(result.current.pages).toHaveLength(1);
  });

  it("rejects when the source cannot page", async () => {
    const { result } = renderHook(
      () =>
        useAgentSessionEventsPages({
          sessionId: SESSION_ID,
          firstCursor: FIRST_CURSOR,
        }),
      { wrapper: createDataSourceWrapper(source(undefined)) }
    );
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
