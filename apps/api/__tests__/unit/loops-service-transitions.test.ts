import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockFn = vi.fn() as Mock & { tx: Mock };
  mockFn.tx = vi.fn();
  return { withDb: mockFn };
});

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

vi.mock("@/app/documents/document-service", () => ({
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: { findInstallationForRepoFullName: vi.fn() },
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@repo/auth/loop-runner-jwt", async (importOriginal) => {
  const { createLoopRunnerJwtMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createLoopRunnerJwtMockModule(importOriginal);
});

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
import { InvalidStatusTransitionError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { buildLoop } from "../fixtures/loop";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };

type TxHandles = {
  updateMany: Mock;
  deleteMany: Mock;
  loopEventCreate: Mock;
};

/**
 * Install handles into mockWithDb.tx so the service call drives them directly.
 * The CAS and token-clear both call `db.loop.updateMany` (token-clear uses
 * updateMany rather than update so the where clause can include organizationId).
 * The mock always returns the CAS count for the first call; the token-clear
 * call uses the same handle but its count is ignored by clearLoopTokens.
 */
function installTxHandles(updateCount: number): TxHandles {
  const handles: TxHandles = {
    updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    deleteMany: vi.fn().mockResolvedValue({ count: updateCount }),
    loopEventCreate: vi.fn().mockResolvedValue({}),
  };
  mockWithDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      loop: { updateMany: handles.updateMany },
      loopTokenRefresh: { deleteMany: handles.deleteMany },
      loopEvent: { create: handles.loopEventCreate },
    })
  );
  return handles;
}

describe("loopsService.updateStatus transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CANCELLED -> COMPLETED succeeds: CAS runs in withDb.tx and writes token cleanup + audit event", async () => {
    const updatedLoop = buildLoop({ status: "COMPLETED" });
    const tx = installTxHandles(1);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue(updatedLoop),
        },
      })
    );

    await expect(
      loopsService.updateStatus("loop-1", "org-1", "COMPLETED")
    ).resolves.toBeDefined();

    // The CAS update lives in withDb.tx; plain withDb is only used for the post-CAS re-fetch.
    expect(mockWithDb.tx).toHaveBeenCalledTimes(1);

    expect(tx.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: expect.objectContaining({
            in: expect.arrayContaining(["CANCELLED"]),
          }),
        }),
      })
    );

    // Token cleanup and audit event are inserted on CAS success for terminal status.
    // Token clear uses updateMany so the where clause can include organizationId
    // (Prisma update requires a unique constraint; (id, organizationId) is not unique).
    expect(tx.updateMany).toHaveBeenCalledWith({
      where: { id: "loop-1", organizationId: "org-1" },
      data: { activeTokenJti: null, tokenExpiresAt: null },
    });
    expect(tx.deleteMany).toHaveBeenCalledWith({
      where: { loopId: "loop-1" },
    });
    expect(tx.loopEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loopId: "loop-1",
          type: "tokens_cleared",
          eventSource: "system",
        }),
      })
    );
  });

  it("PENDING -> RUNNING succeeds: CAS uses plain withDb (no transaction) and no token cleanup runs", async () => {
    const updatedLoop = buildLoop({ status: "RUNNING" });

    // Non-terminal transitions skip withDb.tx — a single updateMany is already
    // SQL-atomic. withDb is invoked for the CAS, the startedAt backfill (if
    // applicable), and the re-fetch.
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const mockCreate = vi.fn().mockResolvedValue({});

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          updateMany: mockUpdateMany,
          findUnique: vi.fn().mockResolvedValue(updatedLoop),
        },
        loopTokenRefresh: { deleteMany: mockDeleteMany },
        loopEvent: { create: mockCreate },
      })
    );

    await expect(
      loopsService.updateStatus("loop-1", "org-1", "RUNNING")
    ).resolves.toBeDefined();

    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("CANCELLED -> FAILED is rejected with InvalidStatusTransitionError", async () => {
    installTxHandles(0);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ status: "CANCELLED", id: "loop-1" }),
        },
      })
    );

    const error = await loopsService
      .updateStatus("loop-1", "org-1", "FAILED")
      .catch((e) => e);

    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
    expect((error as InvalidStatusTransitionError).from).toBe("CANCELLED");
    expect((error as InvalidStatusTransitionError).to).toBe("FAILED");
  });

  // CAS count:0 for terminal target status must reject AND skip cleanup. Two
  // variants cover (a) a self-loop on a terminal status, and (b) a race where
  // another caller transitioned RUNNING -> COMPLETED first.
  it.each([
    {
      label: "COMPLETED -> COMPLETED (self-loop)",
      currentStatus: "COMPLETED" as const,
      expectedFrom: "COMPLETED",
    },
    {
      label: "RUNNING -> COMPLETED (race lost)",
      currentStatus: "RUNNING" as const,
      expectedFrom: "RUNNING",
    },
  ])("$label: CAS count:0 throws InvalidStatusTransitionError and skips token cleanup", async ({
    currentStatus,
    expectedFrom,
  }) => {
    const tx = installTxHandles(0);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ status: currentStatus, id: "loop-1" }),
        },
      })
    );

    const error = await loopsService
      .updateStatus("loop-1", "org-1", "COMPLETED")
      .catch((e) => e);

    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
    expect((error as InvalidStatusTransitionError).from).toBe(expectedFrom);
    expect((error as InvalidStatusTransitionError).to).toBe("COMPLETED");

    // Cleanup must be skipped entirely when count === 0.
    // updateMany was called once (the CAS itself), but NOT a second time for the
    // token-clear path — clearLoopTokens is gated by `if (cas.count > 0)`.
    expect(tx.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.deleteMany).not.toHaveBeenCalled();
    expect(tx.loopEventCreate).not.toHaveBeenCalled();
  });
});

describe("loopsService.cancel transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("RUNNING -> CANCELLED: token cleanup and audit event are written inside withDb.tx", async () => {
    const cancelledLoop = buildLoop({ status: "CANCELLED" });
    const tx = installTxHandles(1);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: vi.fn().mockResolvedValue(cancelledLoop) },
      })
    );

    await expect(loopsService.cancel("loop-1", "org-1")).resolves.toBeDefined();

    expect(mockWithDb.tx).toHaveBeenCalledTimes(1);

    expect(tx.updateMany).toHaveBeenCalledWith({
      where: { id: "loop-1", organizationId: "org-1" },
      data: { activeTokenJti: null, tokenExpiresAt: null },
    });
    expect(tx.deleteMany).toHaveBeenCalledWith({
      where: { loopId: "loop-1" },
    });
    expect(tx.loopEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loopId: "loop-1",
          type: "tokens_cleared",
          eventSource: "system",
        }),
      })
    );
  });

  it("COMPLETED -> CANCELLED is a no-op: CAS count:0 skips cleanup", async () => {
    const tx = installTxHandles(0);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ status: "COMPLETED", id: "loop-1" }),
        },
      })
    );

    const error = await loopsService.cancel("loop-1", "org-1").catch((e) => e);

    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
    expect((error as InvalidStatusTransitionError).from).toBe("COMPLETED");
    expect((error as InvalidStatusTransitionError).to).toBe("CANCELLED");

    expect(tx.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.deleteMany).not.toHaveBeenCalled();
    expect(tx.loopEventCreate).not.toHaveBeenCalled();
  });
});
