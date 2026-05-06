/**
 * Unit tests for the per-org concurrency limit, the per-document active-loop
 * gate, and the P2002 backstop in `loopsService.create`.
 */

import { vi } from "vitest";
import {
  databaseModuleMock,
  dbUtilsModuleMock,
  docPrServiceModuleMock,
  githubModuleMock,
  type LoopsServiceHandles,
  logModuleMock,
  resetLoopsServiceHandles,
  uploadedArtifactsModuleMock,
} from "../fixtures/loops-service-mocks";

const handles = vi.hoisted<LoopsServiceHandles>(() => ({
  loopCreate: vi.fn(),
  loopCount: vi.fn(),
  loopFindFirst: vi.fn(),
  loopFindUnique: vi.fn(),
  loopUpdateMany: vi.fn(),
  orgFindUnique: vi.fn(),
  repoFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => databaseModuleMock(handles));
vi.mock("@repo/github", () => githubModuleMock());
vi.mock("@repo/observability/log", () => logModuleMock());
vi.mock("@/lib/db-utils", () => dbUtilsModuleMock());
vi.mock("@/app/documents/document-pull-request-service", () =>
  docPrServiceModuleMock()
);
vi.mock("@/lib/loops/uploaded-plan-artifacts", () =>
  uploadedArtifactsModuleMock()
);

import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it } from "vitest";
import { LOOP_ACTIVE_INDEX_NAME } from "@/app/loops/loop-constants";
import {
  isConcurrentLoopLimitError,
  isLoopAlreadyActiveError,
  type LoopAlreadyActiveError,
} from "@/app/loops/loop-errors";
import { loopsService, resolveOrgLoopLimit } from "@/app/loops/service";
import { buildPrismaLoop } from "../fixtures/loop";
import { makeP2002Error } from "../fixtures/prisma-errors";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const planLoopInput = {
  command: LoopCommand.Plan,
  documentId: "artifact-1",
  documentVersion: 1,
};

describe("resolveOrgLoopLimit", () => {
  it.each([
    { label: "null settings → default", settings: null, expected: 10 },
    {
      label: "positive integer override",
      settings: { maxConcurrentLoops: 25 },
      expected: 25,
    },
    {
      label: "invalid value (non-positive or non-integer) → default",
      settings: { maxConcurrentLoops: -1 },
      expected: 10,
    },
  ])("returns $label", ({ settings, expected }) => {
    expect(resolveOrgLoopLimit(settings as never)).toBe(expected);
  });
});

describe("loopsService.create", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  describe("concurrent loop limit", () => {
    it("throws ConcurrentLoopLimitError when active count meets the default limit", async () => {
      handles.loopCount.mockResolvedValue(10);

      const err = await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e);

      expect(err).toMatchObject({ limit: 10, activeCount: 10 });
      expect(isConcurrentLoopLimitError(err)).toBe(true);
    });

    it("proceeds when active count is below a custom org limit", async () => {
      handles.loopCount.mockResolvedValue(5);
      handles.orgFindUnique.mockResolvedValueOnce({
        settings: { maxConcurrentLoops: 10 },
      });

      await expect(
        loopsService.create(ORG_ID, USER_ID, planLoopInput)
      ).resolves.toBeDefined();
      expect(handles.loopCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("Chat command exemption", () => {
    const chatInput = {
      command: LoopCommand.Chat,
      documentId: "artifact-1",
      documentVersion: 1,
    };

    it("creates a Chat loop even when an active Chat loop already exists", async () => {
      // Pre-loaded with a record that *would* trigger the gate if it were checked.
      handles.loopFindFirst.mockResolvedValue(
        buildPrismaLoop({ id: "loop-existing", command: LoopCommand.Chat })
      );

      await expect(
        loopsService.create(ORG_ID, USER_ID, chatInput)
      ).resolves.toBeDefined();
      expect(handles.loopCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("P2002 backstop", () => {
    it("rethrows raw P2002 when the post-insert re-read finds no conflict", async () => {
      handles.loopCreate.mockRejectedValueOnce(makeP2002Error());
      handles.loopFindFirst.mockResolvedValue(null);

      const err = await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e);

      expect(isLoopAlreadyActiveError(err)).toBe(false);
      expect((err as { code?: string }).code).toBe("P2002");
      expect(handles.loopFindFirst).toHaveBeenCalledTimes(2);
    });

    // S1 regression: before the two-tier split, the catch path used the
    // operationally-active predicate, which excludes orphan-shaped rows. A
    // P2002 caused by a CLAIMED-with-null-containerId row therefore returned
    // a generic 500 instead of the structured 409.
    it("converts P2002 to LoopAlreadyActiveError when the colliding row is CLAIMED with null containerId", async () => {
      handles.loopCreate.mockRejectedValueOnce(makeP2002Error());
      // First call: pre-insert gate (operational) — returns null for this shape.
      // Second call: post-P2002 catch path (index-blocking) — must find it.
      handles.loopFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
        buildPrismaLoop({
          id: "loop-claimed-no-container",
          status: LoopStatus.Claimed,
          containerId: null,
        })
      );

      const err = (await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e)) as LoopAlreadyActiveError;

      expect(isLoopAlreadyActiveError(err)).toBe(true);
      expect(err.existingLoopId).toBe("loop-claimed-no-container");
      expect(err.existingStatus).toBe(LoopStatus.Claimed);

      // The catch-path query must be the index-blocking shape (no OR /
      // staleness clause). Otherwise it would return null for this row.
      const catchCall = handles.loopFindFirst.mock.calls[1][0] as {
        where: Record<string, unknown>;
      };
      expect(catchCall.where).not.toHaveProperty("OR");
      expect(catchCall.where).toMatchObject({
        status: {
          in: expect.arrayContaining([
            LoopStatus.Pending,
            LoopStatus.Claimed,
            LoopStatus.Running,
          ]),
        },
      });
    });

    it.each([
      {
        label: "Prisma target fields",
        makeError: () =>
          makeP2002Error({
            target: ["artifactId", "command", "artifactVersion"],
          }),
      },
      {
        label: "PrismaPg driver-adapter field metadata",
        makeError: () =>
          makeP2002Error({
            meta: {
              driverAdapterError: {
                name: "DriverAdapterError",
                cause: {
                  kind: "UniqueConstraintViolation",
                  originalCode: "23505",
                  constraint: {
                    fields: ["artifact_id", "command", "artifact_version"],
                  },
                },
              },
            },
            target: null,
          }),
      },
      {
        label: "nested PrismaPg constraint index metadata",
        makeError: () =>
          makeP2002Error({
            meta: {
              driverAdapterError: {
                name: "DriverAdapterError",
                cause: {
                  kind: "UniqueConstraintViolation",
                  originalCode: "23505",
                  constraint: {
                    index: LOOP_ACTIVE_INDEX_NAME,
                  },
                },
              },
            },
            target: null,
          }),
      },
    ])("converts P2002 reported via $label", async ({ makeError }) => {
      handles.loopCreate.mockRejectedValueOnce(makeError());
      handles.loopFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
        buildPrismaLoop({
          id: "loop-active-from-pg-metadata",
          status: LoopStatus.Running,
        })
      );

      const err = (await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e)) as LoopAlreadyActiveError;

      expect(isLoopAlreadyActiveError(err)).toBe(true);
      expect(err.existingLoopId).toBe("loop-active-from-pg-metadata");
      expect(handles.loopFindFirst).toHaveBeenCalledTimes(2);
    });

    it("does not swallow P2002 raised by an unrelated unique constraint", async () => {
      // A P2002 from a different index (e.g. loop_events idempotency) must
      // pass through unchanged. Otherwise the catch path could misreport an
      // unrelated failure as a duplicate-loop error.
      handles.loopCreate.mockRejectedValueOnce(
        makeP2002Error({ target: "loop_events_idempotency_key" })
      );
      // Pre-insert gate finds nothing — so we reach the create call and the
      // P2002 catch path. The catch path should *not* call findFirst again
      // (constraint name doesn't match) and should rethrow the raw error.
      handles.loopFindFirst.mockResolvedValueOnce(null);

      const err = await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e);

      expect(isLoopAlreadyActiveError(err)).toBe(false);
      expect((err as { code?: string }).code).toBe("P2002");
      // Critical: only the pre-insert gate's findFirst call — no second
      // catch-path lookup since the constraint name didn't match.
      expect(handles.loopFindFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe("staleness reaper", () => {
    it("clears stale PENDING rows for the (artifactId, command) slice before gating", async () => {
      await loopsService.create(ORG_ID, USER_ID, planLoopInput);

      const reaper = handles.loopUpdateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(reaper.where).toMatchObject({
        organizationId: ORG_ID,
        artifactId: planLoopInput.documentId,
        command: planLoopInput.command,
        status: LoopStatus.Pending,
        containerId: null,
        createdAt: { lt: expect.any(Date) },
      });
      expect(reaper.data.status).toBe(LoopStatus.Failed);
      expect(handles.loopUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
        handles.loopCount.mock.invocationCallOrder[0]
      );
    });
  });
});
