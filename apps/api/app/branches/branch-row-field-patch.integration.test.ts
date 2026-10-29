/**
 * ISS-9485 — the single-row PATCH contract for `PATCH /branches/[id]`, walked
 * against real Postgres through the REAL route handler. The priority write is
 * echoed and read back from the store. Every row field the type does not let a
 * user write is refused with `unsupported_field`, naming exactly that key; an
 * unknown key not on the row at all is refused by the strict validator
 * instead, carrying no `code`. Self-skips without `DATABASE_URL`.
 */

import {
  ArtifactRowFieldMutationErrorCode,
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { Priority } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { refusedRowFields } from "@/__tests__/utils/row-field-edit";
import {
  seedTwoOrgFixture,
  type TwoOrgFixture,
} from "@/__tests__/utils/two-org-fixture";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const scheduled = vi.hoisted((): Promise<unknown>[] => []);

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    scheduled.push(work);
  },
}));

import { PATCH as patchBranch } from "@/app/branches/[id]/route";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(async () => {
  await Promise.allSettled(scheduled.splice(0));
  await committedOrganizations.cleanup();
});

type Envelope = {
  success: boolean;
  data?: Record<string, unknown>;
  code?: string;
  details?: { unsupportedFields?: string[]; writableFields?: string[] };
};

async function seed(): Promise<TwoOrgFixture> {
  const fixture = await seedTwoOrgFixture();
  committedOrganizations.track(fixture.orgA.organizationId);
  committedOrganizations.track(fixture.orgB.organizationId);
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: fixture.orgA.userId,
      organizationId: fixture.orgA.organizationId,
    },
  });
  return fixture;
}

async function sendBranch(id: string, body: unknown) {
  const response = await patchBranch(
    createMockRequest({ method: "PATCH", body }),
    createMockRouteContext({ id })
  );
  return { status: response.status, json: (await response.json()) as Envelope };
}

function readBranchPriority(branchId: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: branchId },
      select: { priority: true },
    })
  );
}

describeIfDb("PATCH /branches/[id] row fields (ISS-9485)", () => {
  it("echoes the priority write and reads it back from the store", async () => {
    const { orgA } = await seed();

    const { status, json } = await sendBranch(orgA.branchArtifactId, {
      [BranchPatchField.Priority]: Priority.Urgent,
    });

    expect(status).toBe(200);
    expect(json.data).toEqual({
      id: orgA.branchArtifactId,
      priority: Priority.Urgent,
    });
    expect(await readBranchPriority(orgA.branchArtifactId)).toEqual({
      priority: Priority.Urgent,
    });
  });

  it("refuses every non-writable row field with unsupported_field and writes nothing", async () => {
    const { orgA } = await seed();

    for (const key of refusedRowFields(BRANCH_ROW_FIELD_EDIT)) {
      const { status, json } = await sendBranch(orgA.branchArtifactId, {
        [BranchPatchField.Priority]: Priority.Low,
        [key]: "x",
      });
      expect(status, key).toBe(400);
      expect(json.code, key).toBe(
        ArtifactRowFieldMutationErrorCode.UnsupportedField
      );
      expect(json.details?.unsupportedFields, key).toEqual([key]);
    }

    expect(await readBranchPriority(orgA.branchArtifactId)).toEqual({
      priority: null,
    });
  });

  it("refuses an unknown non-row key under the strict validator, carrying no code, and writes nothing", async () => {
    const { orgA } = await seed();

    const { status, json } = await sendBranch(orgA.branchArtifactId, {
      [BranchPatchField.Priority]: Priority.Low,
      futureField: "unknown-to-this-build",
    });

    expect(status).toBe(400);
    expect(json.code).toBeUndefined();
    expect(await readBranchPriority(orgA.branchArtifactId)).toEqual({
      priority: null,
    });
  });

  it("answers another org's branch with 404 artifacts_not_found and leaves it untouched", async () => {
    const { orgB } = await seed();

    const { status, json } = await sendBranch(orgB.branchArtifactId, {
      [BranchPatchField.Priority]: Priority.Urgent,
    });

    expect(status).toBe(404);
    expect(json.code).toBe(ArtifactRowFieldMutationErrorCode.ArtifactsNotFound);
    expect(await readBranchPriority(orgB.branchArtifactId)).toEqual({
      priority: null,
    });
  });
});
