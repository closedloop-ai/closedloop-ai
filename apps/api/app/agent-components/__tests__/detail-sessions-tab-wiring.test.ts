/**
 * ISS-5464 (production wiring): the detail read actually ASKS for the bounded
 * `sessionsTab`. Without this, deleting the argument at the call site leaves the
 * bound's own suite green while the response goes back to shipping all sessions.
 *
 * ISS-9855: the function sorts sessions by recency (lastInvokedAt DESC) and
 * takes the first AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS (50) as the
 * `sessionsTab` page. Branch attribution is NOT paged: it walks every session
 * in bind-sized chunks, so `branchesTab` and the `usageSessions` branch names
 * cover the whole set. The second test pins that walk (chunk count, chunk
 * widths, recency order, and that no id is dropped); the third pins that
 * `usageSessions` is unaffected by the page.
 */
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listByArtifactIds: vi.fn(),
  artifactLinkFindMany: vi.fn(),
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import {
  resolveDetailSessionTabs,
  SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE,
} from "../service/detail-session-tabs";

const ORGANIZATION_ID = "org-wiring";

/**
 * More sessions than the payload bound AND than one attribution chunk, so both
 * the page and the chunk walk are observable.
 */
const SESSION_COUNT = 1218;

function db() {
  return {
    artifactLink: { findMany: mocks.artifactLinkFindMany },
  } as unknown as Parameters<typeof resolveDetailSessionTabs>[0];
}

function invCountBySession(): Map<string, number> {
  return new Map(
    Array.from({ length: SESSION_COUNT }, (_, i) => [`session-${i + 1}`, 3])
  );
}

/**
 * ISS-9855: a recency map with distinct timestamps so the sort order is
 * deterministic. Session N gets lastInvokedAt = base + N ms — so session-1218
 * is the most recently invoked and session-1 the oldest.
 */
function sessionLastInvoked(): Map<string, Date | null> {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  return new Map(
    Array.from({ length: SESSION_COUNT }, (_, i) => [
      `session-${i + 1}`,
      new Date(base + i),
    ])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifactLinkFindMany.mockResolvedValue([]);
  mocks.listByArtifactIds.mockResolvedValue([]);
});

describe("ISS-5464 / ISS-9855 detail sessionsTab wiring", () => {
  it("requests the sessions tab under the payload bound", async () => {
    await resolveDetailSessionTabs(
      db(),
      ORGANIZATION_ID,
      invCountBySession(),
      false,
      undefined,
      sessionLastInvoked()
    );

    expect(mocks.listByArtifactIds).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      expect.any(Array),
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
  });

  it("walks every session through branch attribution in bind-sized chunks (ISS-9855)", async () => {
    await resolveDetailSessionTabs(
      db(),
      ORGANIZATION_ID,
      invCountBySession(),
      false,
      undefined,
      sessionLastInvoked()
    );

    // Branch attribution feeds `usageSessions` AND `branchesTab`. Narrowing
    // this id set to the render page would strip branch names off every
    // `usageSessions` row past it and drop every branch reachable only
    // through a later session — the ISS-9855 defect, moved from the 1,001st
    // session to the 51st. The walk is chunked for the bind budget, not capped.
    const chunks = mocks.artifactLinkFindMany.mock.calls.map(
      (call) => call[0].where.sourceId.in as string[]
    );
    expect(chunks).toHaveLength(
      Math.ceil(SESSION_COUNT / SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE)
    );
    expect(chunks[0]).toHaveLength(SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE);
    expect(chunks.at(-1)).toHaveLength(
      SESSION_COUNT % SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE
    );
    const attributionIds = chunks.flat();
    expect(new Set(attributionIds).size).toBe(SESSION_COUNT);
    expect(attributionIds.length).toBeGreaterThan(
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
    // Recency order: the most recently invoked session leads chunk 1 and the
    // oldest closes the last chunk.
    expect(attributionIds[0]).toBe(`session-${SESSION_COUNT}`);
    expect(attributionIds.at(-1)).toBe("session-1");
  });

  it("serves the recency head as the sessions page (ISS-9855)", async () => {
    await resolveDetailSessionTabs(
      db(),
      ORGANIZATION_ID,
      invCountBySession(),
      false,
      undefined,
      sessionLastInvoked()
    );

    const pageIds = mocks.listByArtifactIds.mock.calls[0][1] as string[];
    expect(pageIds).toHaveLength(AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS);
    expect(pageIds[0]).toBe(`session-${SESSION_COUNT}`);
    expect(pageIds.at(-1)).toBe(
      `session-${SESSION_COUNT - AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS + 1}`
    );
    // The oldest session is not on page one.
    expect(pageIds).not.toContain("session-1");
  });

  it("still emits one usageSessions row per session past the payload bound", async () => {
    const { usageSessions } = await resolveDetailSessionTabs(
      db(),
      ORGANIZATION_ID,
      invCountBySession(),
      false,
      undefined,
      sessionLastInvoked()
    );

    // The bound is on the SUMMARIES, not on the truth: per-session usage
    // attribution is unchanged.
    expect(usageSessions).toHaveLength(SESSION_COUNT);
  });

  it("returns a non-null cursor when sessions exceed the page (ISS-9855)", async () => {
    const { nextCursor, sessionsTabTruncated, branchesTabTruncated } =
      await resolveDetailSessionTabs(
        db(),
        ORGANIZATION_ID,
        invCountBySession(),
        false,
        undefined,
        sessionLastInvoked()
      );

    // More sessions than the page → cursor is set and the sessions page is a
    // floor; branch attribution walked every session, so it is not.
    expect(nextCursor).not.toBeNull();
    expect(sessionsTabTruncated).toBe(true);
    expect(branchesTabTruncated).toBe(false);
  });

  it("returns null cursor when sessions fit on one page (ISS-9855)", async () => {
    const small = new Map(
      Array.from({ length: 10 }, (_, i) => [`session-${i + 1}`, 3] as const)
    );
    const smallRecency = new Map(
      Array.from(
        { length: 10 },
        (_, i) =>
          [`session-${i + 1}`, new Date("2026-01-01T00:00:00Z")] as const
      )
    );
    mocks.listByArtifactIds.mockResolvedValue(
      Array.from({ length: 10 }, () => ({}))
    );

    const { nextCursor, sessionsTabTruncated, branchesTabTruncated } =
      await resolveDetailSessionTabs(
        db(),
        ORGANIZATION_ID,
        small,
        false,
        undefined,
        smallRecency
      );

    expect(nextCursor).toBeNull();
    // listByArtifactIds returns 10 mock rows, invCountBySession has 10 entries
    // → 10 < 10 is false → sessionsTabTruncated is false.
    expect(sessionsTabTruncated).toBe(false);
    expect(branchesTabTruncated).toBe(false);
  });
});
