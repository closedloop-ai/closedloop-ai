import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import {
  ArtifactPriorityMutationErrorCode,
  stalePriorityConflict,
} from "@repo/api/src/types/artifact-priority-mutation";
import {
  ArtifactRowFieldMutationErrorCode,
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { Result, Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { ArtifactType } from "@repo/database";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refusedRowFields } from "@/__tests__/utils/row-field-edit";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222221";
const BRANCH_ID = "66666666-6666-4666-8666-666666666661";
const OTHER_BRANCH_ID = "66666666-6666-4666-8666-666666666662";

const mocks = vi.hoisted(() => ({
  updatePriority: vi.fn(),
  captureBatchPriorityChange: vi.fn(),
  captureFieldEditAnalytics: vi.fn(),
  dispatchSingleArtifactMutationAudits: vi.fn(),
  updatePriorityAfterCommit: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
}));

import { MOCK_TRANSACTION_CLIENT } from "@/__tests__/utils/mock-with-db";

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchPriorityChange: mocks.captureBatchPriorityChange,
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mocks.captureFieldEditAnalytics,
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: {
    updatePriorityAfterCommit: mocks.updatePriorityAfterCommit,
  },
}));
vi.mock("@/app/audit/single-artifact-mutation-audit", () => ({
  dispatchSingleArtifactMutationAudits:
    mocks.dispatchSingleArtifactMutationAudits,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(
        {
          authMethod: "session",
          user: { id: USER_ID, organizationId: ORG_ID },
        },
        request,
        context.params
      );
    },
}));

vi.mock("@/app/documents/artifact-bulk-priority-service", () => ({
  artifactBulkPriorityService: { updatePriority: mocks.updatePriority },
}));

// The GET/DELETE collaborators pull Prisma and PostHog into a route unit test.
vi.mock("@/app/branches/branch-read-service", () => ({
  branchReadService: {},
}));
vi.mock("@/app/branches/branch-pensero-numerator", () => ({
  readBranchPenseroNumerator: vi.fn(),
}));
vi.mock("@/app/branches/branch-selected-pull-request-checks-service", () => ({
  branchSelectedPullRequestChecksService: {},
}));
vi.mock("@/app/branches/branch-service", () => ({ branchService: {} }));

import { PATCH } from "./route";

function request(body: unknown) {
  return new NextRequest("https://api.example.test/branches/x", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withAnyAuthOptions.length = 0;
  mocks.updatePriority.mockResolvedValue(
    Result.ok({ changed: true, beforePriority: null })
  );
});

describe("PATCH /branches/[id] (ISS-10332)", () => {
  it("ISS-10681 AC-001 requires write scope and audits the routed Branch priority transition", async () => {
    const response = await PATCH(
      request({ priority: Priority.Urgent }),
      context(OTHER_BRANCH_ID)
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      id: OTHER_BRANCH_ID,
      priority: Priority.Urgent,
    });
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["write"] }]);
    expect(mocks.updatePriority).toHaveBeenCalledWith({
      artifactId: OTHER_BRANCH_ID,
      artifactType: ArtifactType.BRANCH,
      organizationId: ORG_ID,
      priority: Priority.Urgent,
    });
    expect(mocks.dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: USER_ID,
      changes: [
        {
          action: AuditAction.DocumentPriorityChanged,
          objectId: OTHER_BRANCH_ID,
          before: null,
          after: Priority.Urgent,
        },
      ],
    });
  });

  it("records the committed transition in the activity feed, and nothing for a no-op or a refusal", async () => {
    mocks.updatePriority.mockResolvedValue(
      Result.ok({ changed: true, beforePriority: Priority.Low })
    );
    await PATCH(request({ priority: null }), context(BRANCH_ID));

    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledTimes(1);
    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith({
      tx: MOCK_TRANSACTION_CLIENT,
      organizationId: ORG_ID,
      actor: { userId: USER_ID, authMethod: "session" },
      changes: [{ artifactId: BRANCH_ID, before: Priority.Low, after: null }],
      provenance: undefined,
      stage: "single_update",
    });

    mocks.captureBatchPriorityChange.mockClear();
    mocks.dispatchSingleArtifactMutationAudits.mockClear();
    mocks.updatePriority.mockResolvedValue(
      Result.ok({ changed: false, beforePriority: Priority.High })
    );
    await PATCH(request({ priority: Priority.High }), context(BRANCH_ID));
    mocks.updatePriority.mockResolvedValue(
      Result.err({
        status: Status.NotFound,
        code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
        message: "Artifact not found",
      })
    );
    await PATCH(request({ priority: Priority.High }), context(BRANCH_ID));

    expect(mocks.captureBatchPriorityChange).not.toHaveBeenCalled();
    expect(mocks.dispatchSingleArtifactMutationAudits).not.toHaveBeenCalled();
  });

  it("clears with null and keeps a null expectation distinct from no guard", async () => {
    const cleared = await PATCH(
      request({ priority: null, expectedPriority: null }),
      context(BRANCH_ID)
    );

    expect((await cleared.json()).data).toEqual({
      id: BRANCH_ID,
      priority: null,
    });
    const [input] = mocks.updatePriority.mock.calls[0];
    expect(input.priority).toBeNull();
    expect(input.expectedPriority).toBeNull();

    await PATCH(request({ priority: null }), context(BRANCH_ID));
    expect("expectedPriority" in mocks.updatePriority.mock.calls[1][0]).toBe(
      false
    );
  });

  it("maps a stale expectation to 409 with the shared code and details", async () => {
    const stalePriorities = [
      {
        documentId: BRANCH_ID,
        currentPriority: null,
        expectedPriority: Priority.High,
      },
    ];
    mocks.updatePriority.mockResolvedValue(
      Result.err(stalePriorityConflict(stalePriorities))
    );

    const response = await PATCH(
      request({ priority: Priority.Low, expectedPriority: Priority.High }),
      context(BRANCH_ID)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: ArtifactPriorityMutationErrorCode.StalePriority,
      details: { stalePriorities },
    });
    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        field: ArtifactFieldEditField.Priority,
        result: ArtifactFieldEditOutcome.Conflict,
        artifactCount: 1,
      })
    );
  });

  it("maps the writer's NotFound to 404", async () => {
    mocks.updatePriority.mockResolvedValue(
      Result.err({
        status: Status.NotFound,
        code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
        message: "not found",
      })
    );

    const response = await PATCH(
      request({ priority: Priority.Low }),
      context(BRANCH_ID)
    );
    expect(response.status).toBe(404);
    expect(mocks.captureFieldEditAnalytics).not.toHaveBeenCalled();
  });

  it("refuses a missing or off-vocabulary priority, and any key the route cannot honor", async () => {
    for (const body of [
      {},
      { expectedPriority: Priority.Low },
      { priority: "CRITICAL" },
      { priority: Priority.Low, status: "open" },
      { priority: Priority.Low, name: "renamed" },
      // A bulk receipt through a one-row route (PLN-2086 Milestone 2).
      { priority: Priority.Low, surface: ArtifactStatusEditSurface.Bulk },
    ]) {
      const response = await PATCH(request(body), context(BRANCH_ID));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  // PLN-2086 Milestone 2: the analytics event the #7723 review deferred.
  it("attributes the analytics event to the surface the body names, and re-projects the search row", async () => {
    mocks.updatePriority.mockResolvedValue(
      Result.ok({ changed: true, beforePriority: null })
    );
    const response = await PATCH(
      request({
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.InlineCell,
      }),
      context(BRANCH_ID)
    );

    expect(response.status).toBe(200);
    // Provenance only: the writer never sees it.
    expect(mocks.updatePriority).toHaveBeenCalledWith({
      artifactId: BRANCH_ID,
      artifactType: ArtifactType.BRANCH,
      organizationId: ORG_ID,
      priority: Priority.High,
    });
    expect(mocks.captureFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { surface: ArtifactStatusEditSurface.InlineCell },
        before: null,
        after: Priority.High,
        artifactCount: 1,
      })
    );
    expect(mocks.updatePriorityAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: SearchEntityType.Branch,
        entityId: BRANCH_ID,
      }),
      Priority.High
    );
  });

  it("commits an unattributed write for a surface this build does not know", async () => {
    const response = await PATCH(
      request({ priority: Priority.High, surface: "holodeck" }),
      context(BRANCH_ID)
    );

    expect(response.status).toBe(200);
    expect(mocks.updatePriority).toHaveBeenCalledTimes(1);
    const [capturedAnalytics] = mocks.captureFieldEditAnalytics.mock.calls[0];
    expect(capturedAnalytics).not.toHaveProperty("provenance");
  });
});

describe("PATCH /branches/[id] row fields (ISS-9485)", () => {
  const refused = refusedRowFields(BRANCH_ROW_FIELD_EDIT);

  // The body is `.strict()`, so without the refusal these keys still 400 — as
  // a generic `unrecognized_keys` with no code — which is why every assertion
  // is on the CODE, not only the status.
  it("refuses each row field it does not write with unsupported_field, before the write", async () => {
    expect(refused).toEqual(
      expect.arrayContaining([
        "branchName",
        "status",
        "owner",
        "prState",
        "tags",
      ])
    );
    for (const key of refused) {
      const response = await PATCH(
        request({ priority: Priority.High, [key]: "x" }),
        context(BRANCH_ID)
      );
      const body = await response.json();
      expect(response.status, key).toBe(400);
      expect(body.code, key).toBe(
        ArtifactRowFieldMutationErrorCode.UnsupportedField
      );
      expect(body.details, key).toEqual({
        unsupportedFields: [key],
        writableFields: Object.values(BranchPatchField),
      });
    }
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  it("refuses the row field ahead of a Zod failure elsewhere in the body", async () => {
    const response = await PATCH(
      request({ priority: "CRITICAL", branchName: "main" }),
      context(BRANCH_ID)
    );

    expect((await response.json()).code).toBe(
      ArtifactRowFieldMutationErrorCode.UnsupportedField
    );
  });

  it.each([null, [], { priority: Priority.High, fieldFromANewerClient: 1 }])(
    "leaves %j to the strict validator: 400 with no code",
    async (body) => {
      const response = await PATCH(request(body), context(BRANCH_ID));

      expect(response.status).toBe(400);
      expect((await response.json()).code).toBeUndefined();
      expect(mocks.updatePriority).not.toHaveBeenCalled();
    }
  );
});
