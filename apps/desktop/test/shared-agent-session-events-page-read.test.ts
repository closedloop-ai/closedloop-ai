/**
 * ISS-9857: `getSharedAgentSessionEventsPage`'s coercion seam on its own — the
 * refusals and the request shape that reaches the source, without the IPC
 * registrar around it (that half is `shared-agent-session-events-page-ipc.test.ts`).
 */
import { encodeSessionEventCursor } from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "@repo/api/src/types/agent-session-events-page";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { SessionEventPageRequest } from "../src/main/database/session-event-page-read.js";
import { getSharedAgentSessionEventsPage } from "../src/main/session/shared-agent-session-events-page-read.js";

const SESSION_ID = "events-page-read-session";
const PAGE: AgentSessionEventsPage = { events: [] };

function fakeSource(): {
  source: AgentSessionSyncSource;
  loadSessionEventPage: ReturnType<typeof vi.fn>;
} {
  const loadSessionEventPage = vi.fn(
    (_input: SessionEventPageRequest): Promise<AgentSessionEventsPage | null> =>
      Promise.resolve(PAGE)
  );
  return {
    source: { loadSessionEventPage } as unknown as AgentSessionSyncSource,
    loadSessionEventPage,
  };
}

describe("getSharedAgentSessionEventsPage", () => {
  test("answers null with no source at all, before any coercion matters", async () => {
    expect(
      await getSharedAgentSessionEventsPage(null, { id: SESSION_ID })
    ).toBeNull();
    expect(
      await getSharedAgentSessionEventsPage(undefined, { id: SESSION_ID })
    ).toBeNull();
  });

  test("a null cursor is the first page, not a refusal", async () => {
    const { source, loadSessionEventPage } = fakeSource();
    expect(
      await getSharedAgentSessionEventsPage(source, {
        id: SESSION_ID,
        cursor: null,
      })
    ).toBe(PAGE);
    expect(loadSessionEventPage).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      limit: SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit,
    });
  });

  test("a non-string cursor is refused before the source is asked", async () => {
    const { source, loadSessionEventPage } = fakeSource();
    expect(
      await getSharedAgentSessionEventsPage(source, {
        id: SESSION_ID,
        cursor: 42,
      })
    ).toBeNull();
    expect(loadSessionEventPage).not.toHaveBeenCalled();
  });

  test("a decodable cursor reaches the source as the keyset position", async () => {
    const { source, loadSessionEventPage } = fakeSource();
    const position = {
      createdAt: "2026-06-10T12:17:00.000Z",
      externalEventId: "prefix-2",
    };
    await getSharedAgentSessionEventsPage(source, {
      id: SESSION_ID,
      cursor: encodeSessionEventCursor(position),
      limit: 7,
    });
    expect(loadSessionEventPage).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      after: position,
      limit: 7,
    });
  });
});
