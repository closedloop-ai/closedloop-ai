import { BROWSER_KEY_UNREGISTERED_ERROR_CODE } from "@repo/api/src/types/compute-target";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/compute-target-signing-eligibility", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/compute-target-signing-eligibility")
    >();
  return {
    ...original,
    isComputeTargetSigningEligible: vi.fn(),
  };
});

vi.mock("@/lib/browser-command-public-key-enforcement", () => ({
  enforceRegisteredBrowserPublicKey: vi.fn(),
}));

import { COMMAND_SIGNING_CAPABILITY_KEY } from "@repo/api/src/types/compute-target";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  isRunLoopSigningRequired,
  resolveEffectiveSignedRunLoopIntent,
} from "@/app/documents/[id]/run-loop/signing";
import type { RunLoopBody } from "@/app/documents/[id]/run-loop/validators";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import {
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";

describe("run-loop command signing support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(null);
  });

  it("uses the shared target owner identity when requiring signed run-loop intent", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      id: "target-1",
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
      user: { clerkId: "clerk-owner-1" },
    } as Awaited<ReturnType<typeof computeTargetsService.findById>>);
    vi.mocked(isComputeTargetSigningEligible).mockImplementation(
      async (identity) =>
        identity.userId === "owner-1"
          ? { status: CommandSigningEligibilityStatus.Eligible }
          : {
              status: CommandSigningEligibilityStatus.Ineligible,
              reason: "no_active_managed_key",
            }
    );

    await expect(
      isRunLoopSigningRequired({
        computeTargetId: "target-1",
        requesterUserId: "viewer-1",
        requesterClerkUserId: "clerk-viewer-1",
      })
    ).resolves.toBe(true);

    expect(isComputeTargetSigningEligible).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "owner-1",
      clerkUserId: "clerk-owner-1",
      gatewayId: "gateway-1",
    });
  });

  it("does not inherit the viewer rollout flag for a disabled shared target owner", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      id: "target-1",
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
      user: { clerkId: "clerk-owner-1" },
    } as Awaited<ReturnType<typeof computeTargetsService.findById>>);
    vi.mocked(isComputeTargetSigningEligible).mockImplementation(
      async (identity) =>
        identity.userId === "viewer-1"
          ? { status: CommandSigningEligibilityStatus.Eligible }
          : {
              status: CommandSigningEligibilityStatus.Ineligible,
              reason: "no_active_managed_key",
            }
    );

    await expect(
      isRunLoopSigningRequired({
        computeTargetId: "target-1",
        requesterUserId: "viewer-1",
        requesterClerkUserId: "clerk-viewer-1",
      })
    ).resolves.toBe(false);

    expect(isComputeTargetSigningEligible).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "owner-1",
      clerkUserId: "clerk-owner-1",
      gatewayId: "gateway-1",
    });
  });

  it("rejects a signed run-loop intent whose browser key is unregistered", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      id: "target-1",
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {},
      user: { clerkId: "clerk-owner-1" },
    } as Awaited<ReturnType<typeof computeTargetsService.findById>>);
    vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          error: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
          code: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
        },
        { status: 403 }
      )
    );
    const body = {
      command: RunLoopCommand.Plan,
      additionalRepos: [],
      userIntentSignature: {
        commandId: "0196b1bb-7a00-7000-8000-000000000010",
        signature: "signature",
        signaturePayload: "payload",
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
        body: {
          documentId: "doc-1",
          command: RunLoopCommand.Plan,
          additionalRepos: [],
        },
      },
    } satisfies RunLoopBody;

    const result = await resolveEffectiveSignedRunLoopIntent({
      computeTargetId: "target-1",
      requesterUserId: "viewer-1",
      requesterOrganizationId: "org-1",
      requesterClerkUserId: "clerk-viewer-1",
      documentId: "doc-1",
      body,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        success: false,
        error: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
        code: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
      });
    }
    expect(enforceRegisteredBrowserPublicKey).toHaveBeenCalledWith({
      userId: "viewer-1",
      organizationId: "org-1",
      publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
    });
  });

  it("keeps unsigned legacy run-loop intent behavior unchanged when signing is not required", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      id: "target-1",
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {},
      user: { clerkId: "clerk-owner-1" },
    } as Awaited<ReturnType<typeof computeTargetsService.findById>>);

    const result = await resolveEffectiveSignedRunLoopIntent({
      computeTargetId: "target-1",
      requesterUserId: "viewer-1",
      requesterOrganizationId: "org-1",
      requesterClerkUserId: "clerk-viewer-1",
      documentId: "doc-1",
      body: {
        command: RunLoopCommand.Plan,
        additionalRepos: [],
      } satisfies RunLoopBody,
    });

    expect(result).toEqual({ ok: true, userIntentSignature: undefined });
    expect(enforceRegisteredBrowserPublicKey).not.toHaveBeenCalled();
  });

  it("fails closed with the exact eligibility error when signing lookup is unknown", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      id: "target-1",
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
      user: { clerkId: "clerk-owner-1" },
    } as Awaited<ReturnType<typeof computeTargetsService.findById>>);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Unknown,
      reason: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
    });

    const result = await resolveEffectiveSignedRunLoopIntent({
      computeTargetId: "target-1",
      requesterUserId: "viewer-1",
      requesterOrganizationId: "org-1",
      requesterClerkUserId: "clerk-viewer-1",
      documentId: "doc-1",
      body: {
        command: RunLoopCommand.Plan,
        additionalRepos: [],
      } satisfies RunLoopBody,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        success: false,
        error: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
      });
    }
    expect(enforceRegisteredBrowserPublicKey).not.toHaveBeenCalled();
  });
});
