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

import { beforeEach, describe, expect, it } from "vitest";
import {
  isConcurrentLoopLimitError,
  isLoopAlreadyActiveError,
  type LoopAlreadyActiveError,
  loopsService,
  resolveOrgLoopLimit,
} from "@/app/loops/service";
import { buildPrismaLoop } from "../fixtures/loop";
import { makeP2002Error } from "../fixtures/prisma-errors";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const planLoopInput = {
  command: "PLAN" as const,
  documentId: "artifact-1",
  documentVersion: 1,
};

describe("resolveOrgLoopLimit", () => {
  it.each<[string, unknown, number]>([
    ["null settings", null, 10],
    ["missing key", {}, 10],
    ["positive integer", { maxConcurrentLoops: 25 }, 25],
    ["zero", { maxConcurrentLoops: 0 }, 10],
    ["negative", { maxConcurrentLoops: -1 }, 10],
    ["non-integer string", { maxConcurrentLoops: "25" }, 10],
  ])("returns %s → %d", (_label, settings, expected) => {
    expect(resolveOrgLoopLimit(settings as never)).toBe(expected);
  });
});

describe("loopsService.create", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  describe("concurrent loop limit", () => {
    it("throws ConcurrentLoopLimitError when active count meets the default limit", async () => {
      handles.loopCount.mockResolvedValue(10);

      await expect(
        loopsService.create(ORG_ID, USER_ID, planLoopInput)
      ).rejects.toMatchObject({ limit: 10, activeCount: 10 });

      const err = await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e);
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
      command: "CHAT" as const,
      documentId: "artifact-1",
      documentVersion: 1,
    };

    it("creates a Chat loop even when an active Chat loop already exists", async () => {
      // Pre-loaded with a record that *would* trigger the gate if it were checked.
      handles.loopFindFirst.mockResolvedValue(
        buildPrismaLoop({ id: "loop-existing", command: "CHAT" })
      );

      await expect(
        loopsService.create(ORG_ID, USER_ID, chatInput)
      ).resolves.toBeDefined();
      expect(handles.loopCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("P2002 backstop", () => {
    it("converts P2002 to LoopAlreadyActiveError when the post-insert re-read finds the conflict", async () => {
      handles.loopCreate.mockRejectedValueOnce(makeP2002Error());
      handles.loopFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          buildPrismaLoop({ id: "loop-existing", status: "RUNNING" })
        );

      const err = (await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e)) as LoopAlreadyActiveError;

      expect(isLoopAlreadyActiveError(err)).toBe(true);
      expect(err.existingLoopId).toBe("loop-existing");
      expect(err.existingCommand).toBe("PLAN");
      expect(err.existingStatus).toBe("RUNNING");
    });

    it("rethrows raw P2002 when the post-insert re-read finds no conflict", async () => {
      handles.loopCreate.mockRejectedValueOnce(makeP2002Error());
      handles.loopFindFirst.mockResolvedValue(null);

      const err = await loopsService
        .create(ORG_ID, USER_ID, planLoopInput)
        .catch((e) => e);

      expect(isLoopAlreadyActiveError(err)).toBe(false);
      expect((err as { code?: string }).code).toBe("P2002");
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
        artifactId: planLoopInput.documentId,
        command: planLoopInput.command,
        status: "PENDING",
        containerId: null,
        createdAt: { lt: expect.any(Date) },
      });
      expect(reaper.data.status).toBe("FAILED");
    });
  });
});
