/**
 * Shared dependency mocks for `loopsService` unit tests.
 *
 * Usage (per test file):
 *
 *   import { vi } from "vitest";
 *   import {
 *     databaseModuleMock,
 *     dbUtilsModuleMock,
 *     docPrServiceModuleMock,
 *     githubModuleMock,
 *     logModuleMock,
 *     resetLoopsServiceHandles,
 *     uploadedArtifactsModuleMock,
 *     type LoopsServiceHandles,
 *   } from "../fixtures/loops-service-mocks";
 *
 *   const handles = vi.hoisted<LoopsServiceHandles>(() => ({
 *     loopCreate: vi.fn(),
 *     loopCount: vi.fn(),
 *     loopFindFirst: vi.fn(),
 *     loopFindUnique: vi.fn(),
 *     loopUpdateMany: vi.fn(),
 *     orgFindUnique: vi.fn(),
 *   }));
 *
 *   vi.mock("@repo/database", () => databaseModuleMock(handles));
 *   vi.mock("@repo/github", githubModuleMock);
 *   vi.mock("@repo/observability/log", logModuleMock);
 *   vi.mock("@/lib/db-utils", dbUtilsModuleMock);
 *   vi.mock("@/app/documents/document-pull-request-service", docPrServiceModuleMock);
 *   vi.mock("@/lib/loops/uploaded-plan-artifacts", uploadedArtifactsModuleMock);
 *
 *   beforeEach(() => resetLoopsServiceHandles(handles));
 *
 * The factory functions are referenced lazily by vi.mock — by the time the
 * factory body runs, the import has resolved, so importing them works despite
 * vi.mock hoisting.
 */

import { vi } from "vitest";

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
    .mockResolvedValue({ id: "loop-new", status: "PENDING" });
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
});

export const docPrServiceModuleMock = (): Record<string, unknown> => ({
  documentPullRequestService: { getDocumentPullRequests: vi.fn() },
});

export const uploadedArtifactsModuleMock = (): Record<string, unknown> => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
});
