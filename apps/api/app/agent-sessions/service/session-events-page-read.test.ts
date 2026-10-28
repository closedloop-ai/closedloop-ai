import { decodeSessionEventCursor } from "@repo/api/src/types/agent-session-event-cursor";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "@repo/api/src/types/agent-session-events-page";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  sessionDetail: { findFirst: vi.fn() },
  agentSessionEvent: { findMany: vi.fn() },
};

vi.mock("@repo/database", () => ({
  withDb: (run: (client: typeof db) => unknown) => run(db),
}));

import { readAgentSessionEventsPage } from "./session-events-page-read";

const ORG = "org-a";
const SESSION = "session-1";
const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);

type EventRow = {
  externalEventId: string;
  agentExternalId: string | null;
  eventType: string;
  toolName: string | null;
  eventCreatedAt: Date;
};

function rows(count: number): EventRow[] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `evt-${String(index).padStart(5, "0")}`,
    agentExternalId: index % 2 === 0 ? null : "agent-1",
    eventType: "tool",
    toolName: "Read",
    eventCreatedAt: new Date(T0 + index),
  }));
}

function findManyArgs() {
  return db.agentSessionEvent.findMany.mock.calls[0]?.[0];
}

describe("readAgentSessionEventsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.sessionDetail.findFirst.mockResolvedValue({ artifactId: SESSION });
    db.agentSessionEvent.findMany.mockResolvedValue([]);
  });

  it("answers null, and reads no events, when the org gate misses", async () => {
    db.sessionDetail.findFirst.mockResolvedValue(null);

    await expect(
      readAgentSessionEventsPage({ organizationId: ORG, id: SESSION })
    ).resolves.toBeNull();

    expect(db.sessionDetail.findFirst).toHaveBeenCalledWith({
      where: { artifactId: SESSION, artifact: { is: { organizationId: ORG } } },
      select: { artifactId: true },
    });
    expect(db.agentSessionEvent.findMany).not.toHaveBeenCalled();
  });

  it("reads the first page with no keyset and one row past the default limit", async () => {
    await readAgentSessionEventsPage({ organizationId: ORG, id: SESSION });

    const args = findManyArgs();
    expect(args.where).toEqual({ agentSessionId: SESSION });
    expect(Object.hasOwn(args.where, "OR")).toBe(false);
    expect(args.take).toBe(SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit + 1);
    expect(args.orderBy).toEqual([
      { eventCreatedAt: "asc" },
      { externalEventId: "asc" },
    ]);
  });

  it("carries the cursor as the exact (createdAt, externalEventId) keyset", async () => {
    const createdAt = "2026-06-10T10:00:00.500Z";
    await readAgentSessionEventsPage({
      organizationId: ORG,
      id: SESSION,
      cursor: { createdAt, externalEventId: "evt-00500" },
    });

    expect(findManyArgs().where).toEqual({
      agentSessionId: SESSION,
      OR: [
        { eventCreatedAt: { gt: new Date(createdAt) } },
        {
          eventCreatedAt: new Date(createdAt),
          externalEventId: { gt: "evt-00500" },
        },
      ],
    });
  });

  it("serves exactly limit rows and mints nextCursor from the LAST SERVED row when the probe row came back", async () => {
    const limit = 3;
    db.agentSessionEvent.findMany.mockResolvedValue(rows(limit + 1));

    const page = await readAgentSessionEventsPage({
      organizationId: ORG,
      id: SESSION,
      limit,
    });

    expect(page?.events).toHaveLength(limit);
    expect(page?.events.map((event) => event.externalEventId)).toEqual([
      "evt-00000",
      "evt-00001",
      "evt-00002",
    ]);
    expect(decodeSessionEventCursor(page?.nextCursor)).toEqual({
      createdAt: new Date(T0 + 2).toISOString(),
      externalEventId: "evt-00002",
    });
  });

  it("omits the nextCursor key entirely when the store held no row past the page", async () => {
    const limit = 3;
    db.agentSessionEvent.findMany.mockResolvedValue(rows(limit));

    const page = await readAgentSessionEventsPage({
      organizationId: ORG,
      id: SESSION,
      limit,
    });

    expect(page?.events).toHaveLength(limit);
    expect(Object.hasOwn(page ?? {}, "nextCursor")).toBe(false);
  });

  it("clamps an out-of-range limit to the ceiling before adding the probe row", async () => {
    await readAgentSessionEventsPage({
      organizationId: ORG,
      id: SESSION,
      limit: 999_999,
    });

    expect(findManyArgs().take).toBe(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit + 1
    );
    expect(findManyArgs().take).toBe(2001);
  });

  it("maps a row to the five served fields with an ISO createdAt", async () => {
    db.agentSessionEvent.findMany.mockResolvedValue([
      {
        externalEventId: "evt-1",
        agentExternalId: "agent-7",
        eventType: "tool",
        toolName: "Bash",
        eventCreatedAt: new Date(T0),
      },
    ]);

    const page = await readAgentSessionEventsPage({
      organizationId: ORG,
      id: SESSION,
    });

    expect(page?.events).toEqual([
      {
        externalEventId: "evt-1",
        agentExternalId: "agent-7",
        eventType: "tool",
        toolName: "Bash",
        createdAt: "2026-06-10T10:00:00.000Z",
      },
    ]);
    expect(findManyArgs().select).toEqual({
      externalEventId: true,
      agentExternalId: true,
      eventType: true,
      toolName: true,
      eventCreatedAt: true,
    });
  });
});
