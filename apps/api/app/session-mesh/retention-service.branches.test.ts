import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { sessionMeshRetentionService } from "./retention-service";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (
    await import(
      "@/__tests__/support/session-mesh/session-mesh-db.test-helpers"
    )
  ).meshWithDb(),
}));

const NOW = new Date("2026-09-25T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ORG = "0199a1b2-0000-7000-8000-000000000001";
const PRESENCE_CUTOFF = new Date(NOW.getTime() - 30 * DAY_MS);
const CONTENT_CUTOFF = new Date(NOW.getTime() - 90 * DAY_MS);

let db: MeshDb;

function ids(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    organizationId: ORG,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sessionMeshRetentionService.sweep", () => {
  it("defaults to the current time and deletes nothing when nothing is stale", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue([]);
    db.sessionMeshMessage.findMany.mockResolvedValue([]);
    db.sessionMeshMetricEvent.findMany.mockResolvedValue([]);

    await expect(sessionMeshRetentionService.sweep()).resolves.toEqual({
      presences: 0,
      messages: 0,
      metrics: 0,
      hasMore: false,
    });
    expect(db.sessionMeshPresence.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: PRESENCE_CUTOFF } },
      select: { id: true, organizationId: true },
      orderBy: { expiresAt: "asc" },
      take: 500,
    });
    expect(db.sessionMeshMessage.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: CONTENT_CUTOFF } },
      select: { id: true, organizationId: true },
      orderBy: { expiresAt: "asc" },
      take: 500,
    });
    expect(db.sessionMeshMetricEvent.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: CONTENT_CUTOFF } },
      select: { id: true, organizationId: true },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    expect(db.sessionMeshPresence.deleteMany).not.toHaveBeenCalled();
    expect(db.sessionMeshMessage.deleteMany).not.toHaveBeenCalled();
    expect(db.sessionMeshMetricEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a partial batch with the org predicate and expiry guard, then stops", async () => {
    const presences = ids(2, "p");
    const messages = ids(1, "m");
    const metrics = ids(3, "e");
    db.sessionMeshPresence.findMany.mockResolvedValue(presences);
    db.sessionMeshMessage.findMany.mockResolvedValue(messages);
    db.sessionMeshMetricEvent.findMany.mockResolvedValue(metrics);
    db.sessionMeshPresence.deleteMany.mockResolvedValue({ count: 2 });
    db.sessionMeshMessage.deleteMany.mockResolvedValue({ count: 1 });
    db.sessionMeshMetricEvent.deleteMany.mockResolvedValue({ count: 3 });

    await expect(sessionMeshRetentionService.sweep(NOW)).resolves.toEqual({
      presences: 2,
      messages: 1,
      metrics: 3,
      hasMore: false,
    });
    // Each OR entry carries both id and organizationId, so a deletion can
    // never cross the tenant the row was selected from.
    expect(db.sessionMeshPresence.deleteMany).toHaveBeenCalledWith({
      where: { OR: presences, expiresAt: { lt: PRESENCE_CUTOFF } },
    });
    expect(db.sessionMeshMessage.deleteMany).toHaveBeenCalledWith({
      where: { OR: messages, expiresAt: { lt: CONTENT_CUTOFF } },
    });
    expect(db.sessionMeshMetricEvent.deleteMany).toHaveBeenCalledWith({
      where: { OR: metrics, createdAt: { lt: CONTENT_CUTOFF } },
    });
    expect(db.sessionMeshPresence.findMany).toHaveBeenCalledOnce();
  });

  it("keeps sweeping full batches and reports more work after 20 batches", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue(ids(500, "p"));
    db.sessionMeshMessage.findMany.mockResolvedValue([]);
    db.sessionMeshMetricEvent.findMany.mockResolvedValue([]);
    db.sessionMeshPresence.deleteMany.mockResolvedValue({ count: 500 });

    await expect(sessionMeshRetentionService.sweep(NOW)).resolves.toEqual({
      presences: 10_000,
      messages: 0,
      metrics: 0,
      hasMore: true,
    });
    expect(db.sessionMeshPresence.findMany).toHaveBeenCalledTimes(20);
  });

  it.each([
    ["messages", "sessionMeshMessage"],
    ["metrics", "sessionMeshMetricEvent"],
  ] as const)(
    "continues to a second batch when only %s filled the first",
    async (field, delegate) => {
      db.sessionMeshPresence.findMany.mockResolvedValue([]);
      db.sessionMeshMessage.findMany.mockResolvedValue([]);
      db.sessionMeshMetricEvent.findMany.mockResolvedValue([]);
      db[delegate].findMany.mockResolvedValueOnce(ids(500, "x"));
      db[delegate].deleteMany.mockResolvedValue({ count: 500 });

      const result = await sessionMeshRetentionService.sweep(NOW);

      expect(result.hasMore).toBe(false);
      expect(result[field]).toBe(500);
      expect(db.sessionMeshPresence.findMany).toHaveBeenCalledTimes(2);
    }
  );
});
