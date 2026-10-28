import { PROJECT_TREE_HIERARCHY_REVISION_PARAM } from "@repo/api/src/types/project-tree";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const organizations = createCommittedTestOrganizationTracker();
const auth = vi.hoisted(() => ({ user: { id: "", organizationId: "" } }));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        { user: auth.user, authMethod: "session" },
        request,
        context.params
      ),
}));

import { GET } from "@/app/projects/[id]/tree/route";

describe.skipIf(!keys().DATABASE_URL)(
  "project tree hierarchy revision route (Postgres)",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("joins the route's repeatable-read snapshot without nested isolation", async () => {
      const organizationId = await organizations.create();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id, {
        name: "Revision snapshot",
      });
      auth.user = { id: user.id, organizationId };

      const response = await GET(
        new NextRequest(
          `http://localhost:3002/projects/${projectId}/tree?${PROJECT_TREE_HIERARCHY_REVISION_PARAM}=true`
        ),
        { params: Promise.resolve({ id: projectId }) }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.hierarchyRevision).toEqual(expect.any(String));
      expect(body.data.projectVersion).toBeUndefined();
    });
  }
);
