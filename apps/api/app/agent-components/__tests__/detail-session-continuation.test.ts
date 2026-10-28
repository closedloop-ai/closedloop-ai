import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), links: vi.fn() }));
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.list },
}));

import { decodeSessionTabCursor } from "../component-detail-cursor";
import { sessionsPageQuerySchema } from "../detail-page-validators";
import { resolveDetailSessionTabs } from "../service/detail-session-tabs";

const organizationId = "00000000-0000-4000-8000-000000000001";
const ids = Array.from(
  { length: 127 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);

beforeEach(() => {
  mocks.links.mockResolvedValue([]);
  mocks.list.mockImplementation((_org: string, pageIds: string[]) =>
    Promise.resolve(pageIds.map((id) => ({ id }) as AgentSessionListItem))
  );
});

function read(
  remaining: readonly string[],
  cursor?: ReturnType<typeof decodeSessionTabCursor>
) {
  const counts = new Map(remaining.map((id) => [id, 1]));
  // Tied timestamps straddle page boundaries; untimestamped sessions sort last.
  const recency = new Map(
    remaining.map((id) => [
      id,
      ids.indexOf(id) < 105 ? new Date("2026-10-19T12:00:00.000Z") : null,
    ])
  );
  return resolveDetailSessionTabs(
    { artifactLink: { findMany: mocks.links } } as unknown as Parameters<
      typeof resolveDetailSessionTabs
    >[0],
    organizationId,
    counts,
    false,
    undefined,
    recency,
    cursor ?? undefined
  );
}

describe("component session continuation", () => {
  it("walks every tied and null-dated session once, without changing the whole-cohort evidence", async () => {
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeSessionTabCursor> = null;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = await read(ids, cursor);
      seen.push(...page.sessionsTab.map((session) => session.id));
      expect(page.usageSessions).toHaveLength(ids.length);
      if (!page.nextCursor) {
        break;
      }
      cursor = decodeSessionTabCursor(page.nextCursor);
      expect(cursor).not.toBeNull();
    }
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
    expect(mocks.list).toHaveBeenCalledWith(
      organizationId,
      expect.any(Array),
      50
    );
  });

  it("continues after a removed cursor row by tuple value", async () => {
    const first = await read(ids);
    const cursor = decodeSessionTabCursor(first.nextCursor!);
    const remaining = ids.filter((id) => id !== cursor?.id);
    const next = await read(remaining, cursor);
    expect(next.sessionsTab.map((session) => session.id)).toEqual(
      ids.slice(50, 100)
    );
  });

  it.each([
    "not-json",
    "",
    Buffer.from(JSON.stringify({ t: "bad-date", id: ids[0] })).toString(
      "base64url"
    ),
    Buffer.from(JSON.stringify({ t: null, id: "not-uuid" })).toString(
      "base64url"
    ),
  ])("rejects malformed cursor %s at the HTTP boundary", (cursor) => {
    expect(sessionsPageQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
});
