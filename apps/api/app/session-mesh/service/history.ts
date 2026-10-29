import { withDb } from "@repo/database";
import { boundedMeshPage } from "./bounded-page";

export async function readDeliveryHistoryPage(input: {
  organizationId: string;
  userId: string;
  agentId: string;
  cursor?: string;
}) {
  const now = new Date();
  const rows = await withDb((db) =>
    db.sessionMeshDelivery.findMany({
      where: {
        organizationId: input.organizationId,
        recipientUserId: input.userId,
        recipientAgentId: input.agentId,
        queuedAt: { gte: new Date(now.getTime() - 90 * 86_400_000) },
        ...(input.cursor ? { id: { lt: input.cursor } } : {}),
      },
      include: { message: true },
      // UUIDv7 is insertion ordered and immutable, unlike delivery disposition.
      orderBy: { id: "desc" },
      take: 201,
    })
  );
  const page = boundedMeshPage(rows, 200);
  return {
    messages: page.map((row) =>
      row.message.expiresAt <= now &&
      ["queued", "attempted", "held"].includes(row.status)
        ? { ...row, status: "expired" }
        : row
    ),
    ...(rows.length > page.length ? { nextCursor: page.at(-1)?.id } : {}),
  };
}
