import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheComputeTargetsForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";
import { buildRunLoopRequestBody } from "./run-loop-launcher";

const mockSignDesktopCommand = vi.fn(
  async (_request: unknown, _target: unknown) => ({
    commandId: "signed-command-1",
    signature: "signature",
    signaturePayload: "payload",
    publicKeyFingerprint: "fingerprint",
  })
);

vi.mock(
  "@/lib/desktop-command-signing/command-signer",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/lib/desktop-command-signing/command-signer")
      >();
    return {
      ...original,
      signDesktopCommand: (request: unknown, target: unknown) =>
        mockSignDesktopCommand(request, target),
    };
  }
);

function makeTarget(overrides: Partial<ComputeTarget> = {}): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "Test-MBP",
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
    supportedOperations: [],
    lastSeenAt: new Date("2026-05-10T12:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: true },
    selectedHarness: HarnessType.Claude,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildRunLoopRequestBody signing cache behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheComputeTargetsForSigning([]);
  });

  it("signs run-loop launches for the current eligible cached target", async () => {
    cacheComputeTargetsForSigning([makeTarget()]);

    const body = await buildRunLoopRequestBody({
      documentId: "doc-1",
      command: RunLoopCommand.GeneratePrd,
      computeTargetId: "target-1",
    });

    expect(mockSignDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        pathWithQuery: "/api/gateway/symphony/loop",
        body: expect.objectContaining({
          documentId: "doc-1",
          command: RunLoopCommand.GeneratePrd,
          computeTargetId: "target-1",
        }),
      }),
      expect.objectContaining({ id: "target-1" })
    );
    expect(body.userIntentSignature).toEqual({
      commandId: "signed-command-1",
      signature: "signature",
      signaturePayload: "payload",
      publicKeyFingerprint: "fingerprint",
      body: expect.objectContaining({
        documentId: "doc-1",
        command: RunLoopCommand.GeneratePrd,
        computeTargetId: "target-1",
      }),
    });
  });

  it("omits signing after the refreshed cached target becomes ineligible", async () => {
    cacheComputeTargetsForSigning([
      makeTarget({ serverCapabilities: { computeTargetSigning: true } }),
    ]);
    await buildRunLoopRequestBody({
      documentId: "doc-1",
      command: RunLoopCommand.GeneratePrd,
      computeTargetId: "target-1",
    });
    expect(mockSignDesktopCommand).toHaveBeenCalledTimes(1);

    cacheComputeTargetsForSigning([makeTarget({ serverCapabilities: {} })]);
    const body = await buildRunLoopRequestBody({
      documentId: "doc-1",
      command: RunLoopCommand.GeneratePrd,
      computeTargetId: "target-1",
    });

    expect(mockSignDesktopCommand).toHaveBeenCalledTimes(1);
    expect(body.userIntentSignature).toBeUndefined();
  });

  it("omits signing after the refreshed snapshot drops the target", async () => {
    cacheComputeTargetsForSigning([makeTarget()]);
    cacheComputeTargetsForSigning([]);

    const body = await buildRunLoopRequestBody({
      documentId: "doc-1",
      command: RunLoopCommand.GeneratePrd,
      computeTargetId: "target-1",
    });

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(body.userIntentSignature).toBeUndefined();
  });
});
