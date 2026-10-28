import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { readDeliveryHistoryPage } from "./history";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (
    await import(
      "@/__tests__/support/session-mesh/session-mesh-db.test-helpers"
    )
  ).meshWithDb(),
}));

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ORG = "0199a1b2-0000-7000-8000-000000000001";
const USER = "0199a1b2-0000-7000-8000-000000000002";
const PAST = new Date(NOW.getTime() - 1000);
const FUTURE = new Date(NOW.getTime() + 1000);

let db: MeshDb;

function delivery(id: string, status: string, expiresAt: Date) {
  return { id, status, message: { expiresAt } };
}

const owner = { organizationId: ORG, userId: USER, agentId: "agent-1" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readDeliveryHistoryPage query", () => {
  it("reads 90 days of the owned agent's deliveries newest first", async () => {
    db.sessionMeshDelivery.findMany.mockResolvedValue([]);

    await expect(readDeliveryHistoryPage(owner)).resolves.toEqual({
      messages: [],
    });
    expect(db.sessionMeshDelivery.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        recipientUserId: USER,
        recipientAgentId: "agent-1",
        queuedAt: { gte: new Date(NOW.getTime() - 90 * 86_400_000) },
      },
      include: { message: true },
      orderBy: { id: "desc" },
      take: 201,
    });
  });

  it("continues strictly below a supplied cursor", async () => {
    db.sessionMeshDelivery.findMany.mockResolvedValue([]);

    await readDeliveryHistoryPage({ ...owner, cursor: "d-100" });

    expect(db.sessionMeshDelivery.findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: ORG,
      recipientUserId: USER,
      recipientAgentId: "agent-1",
      queuedAt: { gte: new Date(NOW.getTime() - 90 * 86_400_000) },
      id: { lt: "d-100" },
    });
  });
});

describe("readDeliveryHistoryPage status projection", () => {
  it("reports undelivered work on an expired message as expired", async () => {
    db.sessionMeshDelivery.findMany.mockResolvedValue([
      delivery("d-1", "queued", PAST),
      delivery("d-2", "attempted", NOW),
      delivery("d-3", "held", PAST),
      delivery("d-4", "delivered", PAST),
      delivery("d-5", "queued", FUTURE),
    ]);

    const page = await readDeliveryHistoryPage(owner);

    expect(page.messages.map((row) => [row.id, row.status])).toEqual([
      ["d-1", "expired"],
      ["d-2", "expired"],
      ["d-3", "expired"],
      ["d-4", "delivered"],
      ["d-5", "queued"],
    ]);
    expect(page).not.toHaveProperty("nextCursor");
  });

  it("returns the last row id as the cursor when a further page exists", async () => {
    const rows = Array.from({ length: 201 }, (_, index) =>
      delivery(`d-${String(index).padStart(3, "0")}`, "delivered", FUTURE)
    );
    db.sessionMeshDelivery.findMany.mockResolvedValue(rows);

    const page = await readDeliveryHistoryPage(owner);

    expect(page.messages).toHaveLength(200);
    expect(page.nextCursor).toBe("d-199");
  });
});
