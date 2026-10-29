/**
 * ISS-12251: `PATCH /agent-sessions/{id}` answers from the list projection,
 * which needs a `session_detail` row, so a SESSION artifact without one is
 * refused before anything is written — not written and then answered 404.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

const auth = vi.hoisted(() => ({
  user: { id: "", organizationId: "" },
  scheduled: [] as Promise<unknown>[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context?: { params: Promise<unknown> }) =>
      handler(
        {
          user: auth.user,
          authMethod: "session",
          clerkOrgId: "fixture-org",
          clerkUserId: "fixture-user",
        },
        request,
        context?.params
      ),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    auth.scheduled.push(work);
  },
}));

import { PATCH } from "./[id]/route";

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12251 PATCH on a SESSION artifact with no session_detail",
  () => {
    afterEach(async () => {
      await Promise.all(auth.scheduled.splice(0));
      await tracker.cleanup();
    });

    it("404s an Owner write and leaves the assignee and the activity feed untouched", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const nextOwner = await createTestUser(organizationId);
      auth.user = { id: owner.id, organizationId };
      const sessionId = await withDb(async (db) => {
        const artifact = await db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.SESSION,
            name: "detail-less session",
            status: SESSION_STATUS.ACTIVE,
            assigneeId: owner.id,
          },
          select: { id: true },
        });
        return artifact.id;
      });

      const response = await PATCH(
        new NextRequest(
          `https://api.example.test/agent-sessions/${sessionId}`,
          {
            method: "PATCH",
            body: JSON.stringify({ ownerUserId: nextOwner.id }),
          }
        ),
        { params: Promise.resolve({ id: sessionId }) }
      );

      expect(response.status).toBe(404);
      const [row, receipts] = await withDb((db) =>
        Promise.all([
          db.artifact.findUniqueOrThrow({
            where: { id: sessionId },
            select: { assigneeId: true },
          }),
          db.artifactActivityEvent.count({
            where: { organizationId, artifactId: sessionId },
          }),
        ])
      );
      expect(row.assigneeId).toBe(owner.id);
      expect(receipts).toBe(0);
    });
  }
);
