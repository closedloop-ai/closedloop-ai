import { Status } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { sessionMeshService } from "./service";

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
const MESSAGE_ID = "0199a1b2-0000-7000-8000-0000000000aa";

let db: MeshDb;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sessionMeshService.recordFeedback", () => {
  const key = {
    organizationId_idempotencyKey: {
      organizationId: ORG,
      idempotencyKey: "fb-1",
    },
  };
  const base = {
    organizationId: ORG,
    userId: USER,
    idempotencyKey: "fb-1",
    rationale: "saved a merge conflict",
  };

  it("returns an existing event owned by the same user without writing", async () => {
    const existing = { id: "e-1", userId: USER };
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue(existing);

    await expect(
      sessionMeshService.recordFeedback({ ...base, kind: "useful" })
    ).resolves.toEqual({ ok: true, value: existing });
    expect(db.sessionMeshMetricEvent.findUnique).toHaveBeenCalledWith({
      where: key,
    });
    expect(db.sessionMeshMetricEvent.createMany).not.toHaveBeenCalled();
  });

  it("refuses an idempotency key another user already used", async () => {
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue({
      id: "e-1",
      userId: "someone-else",
    });

    await expect(
      sessionMeshService.recordFeedback({ ...base, kind: "useful" })
    ).resolves.toEqual({ ok: false, error: Status.Forbidden });
    expect(db.sessionMeshMetricEvent.createMany).not.toHaveBeenCalled();
  });

  it("refuses feedback on a message the user never received", async () => {
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue(null);
    db.sessionMeshDelivery.findFirst.mockResolvedValue(null);

    await expect(
      sessionMeshService.recordFeedback({
        ...base,
        kind: "useful",
        messageId: MESSAGE_ID,
        agentId: "agent-1",
      })
    ).resolves.toEqual({ ok: false, error: Status.Forbidden });
    expect(db.sessionMeshDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        recipientUserId: USER,
        messageId: MESSAGE_ID,
      },
      select: { id: true },
    });
    // The message check fails first, so the agent check never runs.
    expect(db.sessionMeshPresence.findFirst).not.toHaveBeenCalled();
    expect(db.sessionMeshMetricEvent.createMany).not.toHaveBeenCalled();
  });

  it("refuses feedback naming an agent the user does not own", async () => {
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue(null);
    db.sessionMeshPresence.findFirst.mockResolvedValue(null);

    await expect(
      sessionMeshService.recordFeedback({
        ...base,
        kind: "useful",
        agentId: "agent-9",
      })
    ).resolves.toEqual({ ok: false, error: Status.Forbidden });
    expect(db.sessionMeshDelivery.findFirst).not.toHaveBeenCalled();
    expect(db.sessionMeshPresence.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, userId: USER, agentId: "agent-9" },
      select: { id: true },
    });
    expect(db.sessionMeshMetricEvent.createMany).not.toHaveBeenCalled();
  });

  it("records owned useful feedback as delivery_useful with its ids", async () => {
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue(null);
    db.sessionMeshDelivery.findFirst.mockResolvedValue({ id: "d-1" });
    db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "p-1" });
    const event = { id: "e-2", userId: USER };
    db.sessionMeshMetricEvent.findUniqueOrThrow.mockResolvedValue(event);

    await expect(
      sessionMeshService.recordFeedback({
        ...base,
        kind: "useful",
        messageId: MESSAGE_ID,
        agentId: "agent-1",
        estimatedTimeSavedMinutes: 12,
        estimatedCostSavedUsd: 3.5,
      })
    ).resolves.toEqual({ ok: true, value: event });
    expect(db.sessionMeshMetricEvent.createMany).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        userId: USER,
        messageId: MESSAGE_ID,
        agentId: "agent-1",
        eventType: "delivery_useful",
        idempotencyKey: "fb-1",
        metadata: {
          rationale: "saved a merge conflict",
          estimatedTimeSavedMinutes: 12,
          estimatedCostSavedUsd: 3.5,
          coordinationOverheadMs: undefined,
        },
      },
      skipDuplicates: true,
    });
    expect(db.sessionMeshMetricEvent.findUniqueOrThrow).toHaveBeenCalledWith({
      where: key,
    });
  });

  it("records unscoped non-useful feedback under its own kind", async () => {
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue(null);
    const event = { id: "e-3", userId: USER };
    db.sessionMeshMetricEvent.findUniqueOrThrow.mockResolvedValue(event);

    await expect(
      sessionMeshService.recordFeedback({
        ...base,
        kind: "coordination_overhead",
        coordinationOverheadMs: 400,
      })
    ).resolves.toEqual({ ok: true, value: event });
    // Strict: an absent messageId/agentId is omitted, not written as undefined.
    expect(
      db.sessionMeshMetricEvent.createMany.mock.calls[0]?.[0]
    ).toStrictEqual({
      data: {
        organizationId: ORG,
        userId: USER,
        eventType: "coordination_overhead",
        idempotencyKey: "fb-1",
        metadata: {
          rationale: "saved a merge conflict",
          estimatedTimeSavedMinutes: undefined,
          estimatedCostSavedUsd: undefined,
          coordinationOverheadMs: 400,
        },
      },
      skipDuplicates: true,
    });
    expect(db.sessionMeshDelivery.findFirst).not.toHaveBeenCalled();
    expect(db.sessionMeshPresence.findFirst).not.toHaveBeenCalled();
  });

  it("refuses when a raced insert left another user's event on the key", async () => {
    db.sessionMeshMetricEvent.findUnique.mockResolvedValue(null);
    db.sessionMeshMetricEvent.findUniqueOrThrow.mockResolvedValue({
      id: "e-4",
      userId: "racer",
    });

    await expect(
      sessionMeshService.recordFeedback({ ...base, kind: "conflict_resolved" })
    ).resolves.toEqual({ ok: false, error: Status.Forbidden });
    expect(
      db.sessionMeshMetricEvent.createMany.mock.calls[0]?.[0].data.eventType
    ).toBe("conflict_resolved");
  });
});
