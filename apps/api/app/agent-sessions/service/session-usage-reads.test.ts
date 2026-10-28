import { SESSION_TOKEN_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-token-event-limits";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  agentSessionTokenEvent: { findMany: vi.fn() },
};

vi.mock("@repo/database", () => ({
  withDb: (run: (client: typeof db) => unknown) => run(db),
}));

import { readSessionTokenEvents } from "./session-usage-reads";

const ORG = "org-a";
const SESSION = "session-1";
const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);

function tokenRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    model: "claude",
    inputTokens: BigInt(index),
    outputTokens: BigInt(2),
    cacheReadTokens: BigInt(3),
    cacheWriteTokens: BigInt(4),
    estimatedCost: index % 2 === 0 ? null : 0.5,
    eventCreatedAt: new Date(T0 + index),
  }));
}

describe("readSessionTokenEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.agentSessionTokenEvent.findMany.mockResolvedValue([]);
  });

  it("reads one row past the cap, org-scoped through the session's artifact", async () => {
    await readSessionTokenEvents({
      organizationId: ORG,
      sessionArtifactId: SESSION,
    });

    const args = db.agentSessionTokenEvent.findMany.mock.calls[0]?.[0];
    expect(args.take).toBe(SESSION_TOKEN_EVENT_MAX_ROWS + 1);
    expect(args.where).toEqual({
      agentSessionId: SESSION,
      session: { artifact: { organizationId: ORG } },
    });
  });

  it("serves the cap and reports truncated when the probe row came back", async () => {
    db.agentSessionTokenEvent.findMany.mockResolvedValue(
      tokenRows(SESSION_TOKEN_EVENT_MAX_ROWS + 1)
    );

    const result = await readSessionTokenEvents({
      organizationId: ORG,
      sessionArtifactId: SESSION,
    });

    expect(result.events).toHaveLength(SESSION_TOKEN_EVENT_MAX_ROWS);
    expect(result.events.at(-1)?.inputTokens).toBe(
      SESSION_TOKEN_EVENT_MAX_ROWS - 1
    );
    expect(result.truncated).toBe(true);
  });

  it("omits the truncated key when the store held no row past the cap", async () => {
    db.agentSessionTokenEvent.findMany.mockResolvedValue(
      tokenRows(SESSION_TOKEN_EVENT_MAX_ROWS)
    );

    const result = await readSessionTokenEvents({
      organizationId: ORG,
      sessionArtifactId: SESSION,
    });

    expect(result.events).toHaveLength(SESSION_TOKEN_EVENT_MAX_ROWS);
    expect(Object.hasOwn(result, "truncated")).toBe(false);
  });

  it("narrows counts to numbers and keeps an unknown cost null", async () => {
    db.agentSessionTokenEvent.findMany.mockResolvedValue(tokenRows(2));

    const { events } = await readSessionTokenEvents({
      organizationId: ORG,
      sessionArtifactId: SESSION,
    });

    expect(events[0]).toEqual({
      model: "claude",
      inputTokens: 0,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      estimatedCostUsd: null,
      eventCreatedAt: new Date(T0),
    });
    expect(events[1]?.estimatedCostUsd).toBe(0.5);
  });
});
