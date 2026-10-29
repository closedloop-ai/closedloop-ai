import { describe, expect, it, vi } from "vitest";
import {
  createHttpAgentSessionsDataSource,
  sessionEventsPagePath,
} from "../agent-sessions-data-source";

describe("HTTP events page (ISS-9857)", () => {
  it("builds the sibling route with only the params the caller set", () => {
    expect(sessionEventsPagePath({ id: "s 1" })).toBe(
      "/agent-sessions/s%201/events"
    );
    expect(sessionEventsPagePath({ id: "s1", cursor: "abc" })).toBe(
      "/agent-sessions/s1/events?cursor=abc"
    );
    expect(sessionEventsPagePath({ id: "s1", cursor: "abc", limit: 50 })).toBe(
      "/agent-sessions/s1/events?cursor=abc&limit=50"
    );
  });

  it("issues the GET through the shared client and returns the page as served", async () => {
    const page = { events: [], nextCursor: "next" };
    const get = vi.fn().mockResolvedValue(page);
    const dataSource = createHttpAgentSessionsDataSource({ get });
    await expect(
      dataSource.eventsPage?.({ id: "s1", cursor: "abc", limit: 10 })
    ).resolves.toBe(page);
    expect(get).toHaveBeenCalledWith(
      "/agent-sessions/s1/events?cursor=abc&limit=10"
    );
  });
});
