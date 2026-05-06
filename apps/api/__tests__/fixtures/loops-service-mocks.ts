/**
 * Shared dependency mocks for `loopsService` unit tests. See
 * `__tests__/unit/loops-service-concurrent-limit.test.ts` for canonical usage.
 */

import { LoopStatus } from "@repo/api/src/types/loop";
import { vi } from "vitest";
import { z } from "zod";

const prismaErrorCodeSchema = z.object({ code: z.string() }).passthrough();

export type LoopsServiceHandles = {
  loopCreate: ReturnType<typeof vi.fn>;
  loopCount: ReturnType<typeof vi.fn>;
  loopFindFirst: ReturnType<typeof vi.fn>;
  loopFindUnique: ReturnType<typeof vi.fn>;
  loopUpdateMany: ReturnType<typeof vi.fn>;
  orgFindUnique: ReturnType<typeof vi.fn>;
};

/** Reset every handle to its default behaviour. Call from `beforeEach`. */
export function resetLoopsServiceHandles(handles: LoopsServiceHandles): void {
  handles.loopCreate
    .mockReset()
    .mockResolvedValue({ id: "loop-new", status: LoopStatus.Pending });
  handles.loopCount.mockReset().mockResolvedValue(0);
  handles.loopFindFirst.mockReset().mockResolvedValue(null);
  handles.loopFindUnique.mockReset().mockResolvedValue(null);
  handles.loopUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  handles.orgFindUnique.mockReset().mockResolvedValue({ settings: null });
}

export function databaseModuleMock(
  handles: LoopsServiceHandles
): Record<string, unknown> {
  return {
    withDb: Object.assign(
      vi.fn((fn: (db: unknown) => unknown) =>
        fn({
          loop: {
            create: handles.loopCreate,
            count: handles.loopCount,
            findFirst: handles.loopFindFirst,
            findUnique: handles.loopFindUnique,
            updateMany: handles.loopUpdateMany,
            findMany: vi.fn().mockResolvedValue([]),
          },
          organization: { findUnique: handles.orgFindUnique },
          loopEvent: {
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
          },
        })
      ),
      { tx: vi.fn() }
    ),
    GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  };
}

export const githubModuleMock = (): Record<string, unknown> => ({
  getInstallationAccessToken: vi.fn(),
  verifyInstallationBranchExists: vi.fn().mockResolvedValue(true),
});

export const logModuleMock = (): Record<string, unknown> => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

function getMockPrismaErrorCode(error: unknown): string | undefined {
  const result = prismaErrorCodeSchema.safeParse(error);
  return result.success ? result.data.code : undefined;
}

export const dbUtilsModuleMock = (): Record<string, unknown> => ({
  basicUserSelect: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
  getPrismaErrorCode: vi.fn(getMockPrismaErrorCode),
});

export const docPrServiceModuleMock = (): Record<string, unknown> => ({
  documentPullRequestService: { getDocumentPullRequests: vi.fn() },
});

export const uploadedArtifactsModuleMock = (): Record<string, unknown> => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
});
