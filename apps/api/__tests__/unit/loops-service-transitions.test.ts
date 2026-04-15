import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

// Transitive dependencies required by loopsService (service.ts imports modules that pull in these)
vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(),
  RunTaskCommand: vi.fn(),
  StopTaskCommand: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/artifacts/service", () => ({
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: { findInstallationForRepoFullName: vi.fn() },
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  issueLoopRunnerToken: vi.fn(),
}));

vi.mock("@/lib/aws-credentials", () => ({
  getAwsCredentials: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: vi.fn().mockResolvedValue(null),
  downloadArtifactFile: vi.fn().mockResolvedValue(null),
  downloadPromptSnapshotMarkdownEntries: vi.fn().mockResolvedValue([]),
  getStateKeyPrefix: vi.fn().mockReturnValue("org/loops/loop-1/run-1"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-url"),
  scrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: () => null,
  COMMAND_HANDLERS: {},
}));

import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InvalidStatusTransitionError,
  loopsService,
} from "@/app/loops/service";
import { buildLoop } from "../fixtures/loop";

const mockWithDb = withDb as unknown as Mock;

describe("loopsService.updateStatus transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CANCELLED -> COMPLETED succeeds: updateMany count:1, re-fetch findUnique returns updated loop", async () => {
    const updatedLoop = buildLoop({ status: "COMPLETED" });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        loop: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue(updatedLoop),
        },
      };
      return callback(db);
    });

    await expect(
      loopsService.updateStatus("loop-1", "org-1", "COMPLETED")
    ).resolves.toBeDefined();

    // Verify updateMany was called with CANCELLED in the status.in where clause
    const updateManyCalls = mockWithDb.mock.calls;
    let foundUpdateManyWithCancelled = false;
    for (const [callbackFn] of updateManyCalls) {
      const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const mockFindUnique = vi.fn().mockResolvedValue(updatedLoop);
      await callbackFn({
        loop: { updateMany: mockUpdateMany, findUnique: mockFindUnique },
      });
      if (mockUpdateMany.mock.calls.length > 0) {
        const [args] = mockUpdateMany.mock.calls;
        if (
          args[0]?.where?.status?.in &&
          Array.isArray(args[0].where.status.in)
        ) {
          expect(args[0].where.status.in).toEqual(
            expect.arrayContaining(["CANCELLED"])
          );
          foundUpdateManyWithCancelled = true;
        }
      }
    }
    expect(foundUpdateManyWithCancelled).toBe(true);
  });

  it("CANCELLED -> FAILED is rejected with InvalidStatusTransitionError", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        loop: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi
            .fn()
            .mockResolvedValue({ status: "CANCELLED", id: "loop-1" }),
        },
      };
      return callback(db);
    });

    const error = await loopsService
      .updateStatus("loop-1", "org-1", "FAILED")
      .catch((e) => e);

    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
    expect((error as InvalidStatusTransitionError).from).toBe("CANCELLED");
    expect((error as InvalidStatusTransitionError).to).toBe("FAILED");
  });

  it("COMPLETED -> COMPLETED is rejected with InvalidStatusTransitionError", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        loop: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi
            .fn()
            .mockResolvedValue({ status: "COMPLETED", id: "loop-1" }),
        },
      };
      return callback(db);
    });

    const error = await loopsService
      .updateStatus("loop-1", "org-1", "COMPLETED")
      .catch((e) => e);

    // COMPLETED is not in the valid source statuses for COMPLETED (COMPLETED's
    // allowed-next set is empty), so the atomic updateMany matches zero rows
    // and the service throws InvalidStatusTransitionError.
    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
    expect((error as InvalidStatusTransitionError).from).toBe("COMPLETED");
    expect((error as InvalidStatusTransitionError).to).toBe("COMPLETED");
  });
});
