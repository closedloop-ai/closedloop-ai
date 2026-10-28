import {
  BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_KEY_REVOCATION_OPERATION_ID,
  BROWSER_KEY_REVOCATION_PATH,
  BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE,
  BROWSER_KEY_UNREGISTERED_ERROR_CODE,
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
  type ComputeTarget,
  DesktopCommandStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeStoredCommand } from "@/__tests__/support/compute-targets/compute-target.test-fixtures";
import { POST as commandsPOST } from "@/app/compute-targets/[id]/commands/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import { env } from "@/env";
import type { AuthContext } from "@/lib/auth/with-auth";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import {
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
  CommandSigningEligibilityStatus,
  CommandSigningRequirementStatus,
  isComputeTargetSigningEligible,
  resolveCommandSigningRequirement,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      findAccessibleById: vi.fn(),
      findById: vi.fn(),
      findOwnedById: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      heartbeat: vi.fn(),
    },
  };
});

vi.mock("@/lib/relay-event-bus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/relay-event-bus")>();
  return {
    ...original,
    relayEventBus: {
      ...original.relayEventBus,
      publishOperation: vi.fn(),
    },
  };
});

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      createCommand: vi.fn(),
      ingestCommandEvent: vi.fn(),
      markCommandExpired: vi.fn(),
    },
  };
});

vi.mock("@/lib/compute-target-signing-eligibility", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/compute-target-signing-eligibility")
    >();
  return {
    ...original,
    isComputeTargetSigningEligible: vi.fn(),
    // The commands route now derives its effective signing policy through the
    // shared resolver (FEA-4164). Enforcing-capability tests drive this seam;
    // the resolver's own identity-threading + Unknown parity is covered in
    // lib/__tests__/compute-target-signing-eligibility.test.ts.
    resolveCommandSigningRequirement: vi.fn(),
  };
});

vi.mock("@/lib/browser-command-public-key-enforcement", () => ({
  enforceRegisteredBrowserPublicKey: vi.fn(),
}));

const mockTarget: ComputeTarget = {
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "machine-1",
  platform: "darwin",
  capabilities: {},
  supportedOperations: ["symphony_chat"],
  gatewayId: "gateway-1",
  lastSeenAt: new Date(),
  isOnline: true,
  isSharedWithOrg: false,
  selectedHarness: HarnessType.Claude,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SIGNED_COMMAND_BODY = {
  commandId: "0196b1bb-7a00-7000-8000-000000000010",
  operationId: "symphony_chat",
  method: "POST",
  path: "/api/gateway/symphony/chat/run-1",
  streaming: true,
  signature: "YWJj",
  signaturePayload: "payload",
  publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
};

function mockCommandRelayDelivery(result: {
  deliveredToSubscriber: boolean;
  reason?: string;
}) {
  if (env.RELAY_API_URL) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            delivered: result.deliveredToSubscriber,
            ...(result.reason ? { reason: result.reason } : {}),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );
    return;
  }

  vi.mocked(relayEventBus.publishOperation).mockReturnValue(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(desktopCommandStore.createCommand).mockResolvedValue({
    command: makeStoredCommand({ status: DesktopCommandStatus.Queued }),
    deduped: false,
  });
  vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
    accepted: true,
    duplicate: false,
    sequence: 1,
  });
  vi.mocked(desktopCommandStore.markCommandExpired).mockResolvedValue(
    undefined
  );
  vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(null);
  vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
    status: CommandSigningEligibilityStatus.Ineligible,
    reason: "no_active_managed_key",
  });
  // Default: signing not required (mirrors the Ineligible eligibility default).
  // Enforcing tests override this to Required/Unknown.
  vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
    status: CommandSigningRequirementStatus.NotRequired,
  });
  mockIsFeatureEnabled.mockResolvedValue(true);
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: "user-1",
      organizationId: "org-1",
    },
  });
});

describe("POST /compute-targets/:id/commands", () => {
  it("dispatches gateway paths without rewriting to a legacy namespace", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget
    );
    let relayFetch: ReturnType<typeof vi.fn> | null = null;
    if (env.RELAY_API_URL) {
      relayFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ delivered: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", relayFetch);
    } else {
      vi.mocked(relayEventBus.publishOperation).mockReturnValue({
        deliveredToSubscriber: true,
      });
    }

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "symphony_chat",
          method: "POST",
          path: "/api/gateway/symphony/chat/run-1",
          streaming: true,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        path: "/api/gateway/symphony/chat/run-1",
      }),
      expect.anything(),
      undefined
    );

    if (relayFetch && env.RELAY_API_URL) {
      expect(relayFetch).toHaveBeenCalledWith(
        `${env.RELAY_API_URL}/dispatch`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "x-internal-secret": env.INTERNAL_API_SECRET,
          }),
        })
      );

      const [, init] = relayFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(
        expect.objectContaining({
          targetId: "target-1",
          operation: expect.objectContaining({
            path: "/api/gateway/symphony/chat/run-1",
          }),
        })
      );
      return;
    }

    expect(relayEventBus.publishOperation).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        params: expect.objectContaining({
          request: expect.objectContaining({
            path: "/api/gateway/symphony/chat/run-1",
          }),
        }),
      })
    );
  });

  it("requires signing for the caller's own target when the shared resolver returns Required", async () => {
    // The identity threading into isComputeTargetSigningEligible is asserted
    // directly against the real resolver in
    // lib/__tests__/compute-target-signing-eligibility.test.ts; here we drive the
    // route's behavior off the resolver's Required outcome. Lookups are
    // owner-only (ISS-12617), so the target is always the caller's.
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.Required,
    });
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      gatewayId: "gateway-user-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    });

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "symphony_chat",
          method: "POST",
          path: "/api/gateway/symphony/chat/run-1",
          streaming: true,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Command signing is required for this compute target",
    });
    // The route derived its policy through the shared resolver, threading the
    // requester identity + gateway, without a second target read.
    expect(resolveCommandSigningRequirement).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        targetUserId: "user-1",
        requesterUserId: "user-1",
        requesterClerkUserId: mockAuthContext.user.clerkId,
        targetGatewayId: "gateway-user-1",
      })
    );
    expect(
      vi.mocked(resolveCommandSigningRequirement).mock.calls[0]?.[0]
    ).not.toHaveProperty("targetOwnerClerkUserId");
    expect(computeTargetsService.findById).not.toHaveBeenCalled();
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });

  it("fails closed before command creation when signing eligibility is unknown", async () => {
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.Unknown,
    });
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    });

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "symphony_chat",
          method: "POST",
          path: "/api/gateway/symphony/chat/run-1",
          streaming: true,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
    });
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });

  it("fails closed on unknown signing eligibility even when signature fields are present", async () => {
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.Unknown,
    });
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    });

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: SIGNED_COMMAND_BODY,
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
    });
    expect(enforceRegisteredBrowserPublicKey).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      publicKeyFingerprint: SIGNED_COMMAND_BODY.publicKeyFingerprint,
    });
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(relayEventBus.publishOperation).not.toHaveBeenCalled();
  });

  it("does not force signing when the shared resolver returns NotRequired for a target whose owner is disabled", async () => {
    // Owner-disabled → the resolver returns NotRequired (the identity selection
    // that produces this is asserted against the real resolver in the lib test).
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      gatewayId: "gateway-user-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    });
    mockCommandRelayDelivery({
      deliveredToSubscriber: true,
    });

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "symphony_chat",
          method: "POST",
          path: "/api/gateway/symphony/chat/run-1",
          streaming: true,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    expect(desktopCommandStore.createCommand).toHaveBeenCalled();
    expect(resolveCommandSigningRequirement).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: "user-1",
        targetGatewayId: "gateway-user-1",
      })
    );
  });

  it.each([
    ["missing", undefined],
    ["false", false],
    ["malformed string", "true"],
  ])(
    "accepts unsigned legacy commands when commandSigningRequired is %s",
    async (_label, commandSigningRequired) => {
      vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
        status: CommandSigningEligibilityStatus.Eligible,
      });
      vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
        ...mockTarget,
        capabilities: {
          [COMMAND_SIGNING_CAPABILITY_KEY]: true,
          ...(commandSigningRequired === undefined
            ? {}
            : {
                [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]:
                  commandSigningRequired,
              }),
        },
      });
      mockCommandRelayDelivery({
        deliveredToSubscriber: true,
      });

      const response = await commandsPOST(
        createMockRequest({
          method: "POST",
          body: {
            operationId: "symphony_chat",
            method: "POST",
            path: "/api/gateway/symphony/chat/run-1",
            streaming: true,
          },
        }),
        createMockRouteContext({ id: "target-1" })
      );

      expect(response.status).toBe(200);
      expect(desktopCommandStore.createCommand).toHaveBeenCalled();
    }
  );

  it("rejects signed commands when the browser key is no longer registered", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget
    );
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

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: SIGNED_COMMAND_BODY,
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
      code: BROWSER_KEY_UNREGISTERED_ERROR_CODE,
    });
    expect(enforceRegisteredBrowserPublicKey).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      publicKeyFingerprint: SIGNED_COMMAND_BODY.publicKeyFingerprint,
    });
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(relayEventBus.publishOperation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "operation id",
      {
        operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
        path: "/api/gateway/symphony/chat/run-1",
      },
    ],
    [
      "approval request operation id",
      {
        operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
        path: "/api/gateway/symphony/chat/run-1",
      },
    ],
    [
      "path",
      {
        operationId: "symphony_chat",
        path: BROWSER_KEY_REVOCATION_PATH,
      },
    ],
    [
      "approval request path",
      {
        operationId: "symphony_chat",
        path: BROWSER_KEY_APPROVAL_REQUEST_PATH,
      },
    ],
  ])(
    "rejects the reserved browser-key internal %s",
    async (_label, override) => {
      vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
        mockTarget
      );

      const response = await commandsPOST(
        createMockRequest({
          method: "POST",
          body: {
            operationId: override.operationId,
            method: "POST",
            path: override.path,
            streaming: false,
          },
        }),
        createMockRouteContext({ id: "target-1" })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "Browser key internal commands are internal",
        code: BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE,
      });
      expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
      expect(enforceRegisteredBrowserPublicKey).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["false", false],
    ["missing", undefined],
  ])(
    "accepts and relays valid signed commands when commandSigningRequired is %s",
    async (_label, commandSigningRequired) => {
      vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
        status: CommandSigningEligibilityStatus.Eligible,
      });
      vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
        ...mockTarget,
        capabilities: {
          [COMMAND_SIGNING_CAPABILITY_KEY]: true,
          ...(commandSigningRequired === undefined
            ? {}
            : {
                [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]:
                  commandSigningRequired,
              }),
        },
      });
      mockCommandRelayDelivery({
        deliveredToSubscriber: true,
      });

      const response = await commandsPOST(
        createMockRequest({
          method: "POST",
          body: SIGNED_COMMAND_BODY,
        }),
        createMockRouteContext({ id: "target-1" })
      );

      expect(response.status).toBe(200);
      expect(enforceRegisteredBrowserPublicKey).toHaveBeenCalledWith({
        userId: "user-1",
        organizationId: "org-1",
        publicKeyFingerprint: SIGNED_COMMAND_BODY.publicKeyFingerprint,
      });
      expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
        "target-1",
        expect.not.objectContaining({
          signature: expect.anything(),
          signaturePayload: expect.anything(),
          publicKeyFingerprint: expect.anything(),
        }),
        expect.anything(),
        undefined
      );
      if (env.RELAY_API_URL) {
        const relayFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
        const [, init] = relayFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(init.body));
        expect(body.operation).toEqual(
          expect.objectContaining({
            signature: SIGNED_COMMAND_BODY.signature,
            signaturePayload: SIGNED_COMMAND_BODY.signaturePayload,
            publicKeyFingerprint: SIGNED_COMMAND_BODY.publicKeyFingerprint,
          })
        );
        return;
      }

      expect(relayEventBus.publishOperation).toHaveBeenCalledWith(
        "target-1",
        expect.objectContaining({
          params: expect.objectContaining({
            signature: SIGNED_COMMAND_BODY.signature,
            signaturePayload: SIGNED_COMMAND_BODY.signaturePayload,
            publicKeyFingerprint: SIGNED_COMMAND_BODY.publicKeyFingerprint,
          }),
        })
      );
    }
  );

  it("expires signed commands when relay delivery reports the target offline", async () => {
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.Required,
    });
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    });
    mockCommandRelayDelivery({
      deliveredToSubscriber: false,
      reason: "target_offline",
    });

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: {
          ...SIGNED_COMMAND_BODY,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        commandId: "cmd-1",
        status: DesktopCommandStatus.Expired,
      },
    });
    expect(desktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      "cmd-1",
      "signed_command_delivery_failed:target_offline",
      expect.objectContaining({
        commandId: "cmd-1",
        operationId: "symphony_chat",
        computeTargetId: "target-1",
      })
    );
  });
});
