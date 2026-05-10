import {
  BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_KEY_REVOCATION_OPERATION_ID,
  BROWSER_KEY_REVOCATION_PATH,
  BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE,
  BROWSER_KEY_UNREGISTERED_ERROR_CODE,
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
  DesktopCommandStatus,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { vi } from "vitest";
import { POST as commandsPOST } from "@/app/compute-targets/[id]/commands/route";
import { POST as dispatchPOST } from "@/app/compute-targets/[id]/operations/route";
import { POST as resultsPOST } from "@/app/compute-targets/[id]/results/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import { env } from "@/env";
import type { AuthContext } from "@/lib/auth/with-auth";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import { isComputeTargetSigningSupportedForUser } from "@/lib/command-signing-feature";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
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
      publishResult: vi.fn(),
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
      createFromRelayOperation: vi.fn(),
      findCommandIdByOperationId: vi.fn(),
      ingestCommandEvent: vi.fn(),
      markCommandExpired: vi.fn(),
    },
  };
});

vi.mock("@/lib/command-signing-feature", () => ({
  isComputeTargetSigningSupportedForUser: vi.fn(),
}));

vi.mock("@/lib/browser-command-public-key-enforcement", () => ({
  enforceRegisteredBrowserPublicKey: vi.fn(),
}));

const mockTarget = {
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "machine-1",
  platform: "darwin",
  capabilities: {},
  supportedOperations: ["symphony_chat"],
  lastSeenAt: new Date(),
  isOnline: true,
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
  vi.mocked(desktopCommandStore.createFromRelayOperation).mockResolvedValue({
    command: {
      commandId: "cmd-1",
    },
    deduped: false,
  } as any);
  vi.mocked(desktopCommandStore.createCommand).mockResolvedValue({
    command: {
      commandId: "cmd-1",
      status: "queued",
    },
    deduped: false,
  } as any);
  vi.mocked(desktopCommandStore.findCommandIdByOperationId).mockResolvedValue(
    null
  );
  vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
    accepted: true,
    duplicate: false,
    sequence: 1,
  });
  vi.mocked(desktopCommandStore.markCommandExpired).mockResolvedValue({
    commandId: "cmd-1",
    status: DesktopCommandStatus.Expired,
  } as any);
  vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(null);
  vi.mocked(isComputeTargetSigningSupportedForUser).mockResolvedValue(false);
  vi.mocked(computeTargetsService.findById).mockResolvedValue({
    ...mockTarget,
    user: { clerkId: "clerk-user-1", firstName: "Owner", lastName: "User" },
  } as any);
  mockAuthContext = createTestAuthContext({
    user: {
      id: "user-1",
      organizationId: "org-1",
    } as any,
  });
});

describe("POST /compute-targets/:id/operations", () => {
  it("rejects dispatch when target is offline", async () => {
    vi.mocked(computeTargetsService.markStaleTargetsOffline).mockResolvedValue(
      0
    );
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
      ...mockTarget,
      isOnline: false,
    } as any);

    const response = await dispatchPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "op-1",
          operation: "symphony_chat",
          params: { ticketId: "ENG-1" },
          streaming: true,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Compute target offline");
  });

  it("publishes operation when target is online", async () => {
    vi.mocked(computeTargetsService.markStaleTargetsOffline).mockResolvedValue(
      0
    );
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      mockTarget as any
    );
    vi.mocked(relayEventBus.publishOperation).mockReturnValue({
      deliveredToSubscriber: true,
    });

    const response = await dispatchPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "op-1",
          operation: "symphony_chat",
          params: { ticketId: "ENG-1" },
          streaming: true,
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      queued: true,
      deliveredToSubscriber: true,
    });
    expect(relayEventBus.publishOperation).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        operationId: "op-1",
      })
    );
  });

  it.each([
    [
      "revocation operation id",
      {
        operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
        operation: "engineer_http_request",
        params: {},
      },
    ],
    [
      "approval-request operation id",
      {
        operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
        operation: "engineer_http_request",
        params: {},
      },
    ],
    [
      "approval-request path",
      {
        operationId: "approval-request-path",
        operation: "engineer_http_request",
        params: {
          request: {
            path: BROWSER_KEY_APPROVAL_REQUEST_PATH,
          },
        },
      },
    ],
  ])("rejects the reserved browser-key %s before command creation", async (_label, operation) => {
    const response = await dispatchPOST(
      createMockRequest({
        method: "POST",
        body: {
          ...operation,
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
    expect(
      computeTargetsService.markStaleTargetsOffline
    ).not.toHaveBeenCalled();
    expect(desktopCommandStore.createFromRelayOperation).not.toHaveBeenCalled();
    expect(relayEventBus.publishOperation).not.toHaveBeenCalled();
  });
});

describe("POST /compute-targets/:id/commands", () => {
  it("rewrites gateway paths to the stored legacy namespace before dispatch", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: { desktopApiNamespace: "engineer" },
    } as any);
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
        path: "/api/engineer/symphony/chat/run-1",
      }),
      expect.anything()
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
            path: "/api/engineer/symphony/chat/run-1",
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
            path: "/api/engineer/symphony/chat/run-1",
          }),
        }),
      })
    );
  });

  it("requires signing for shared targets using the target owner's feature flag identity", async () => {
    vi.mocked(isComputeTargetSigningSupportedForUser).mockImplementation(
      async (identity) => identity.userId === "owner-1"
    );
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      userId: "owner-1",
      isSharedWithOrg: true,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    } as any);
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      ...mockTarget,
      userId: "owner-1",
      user: { clerkId: "clerk-owner-1", firstName: "Owner", lastName: "One" },
    } as any);

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
    expect(isComputeTargetSigningSupportedForUser).toHaveBeenCalledWith({
      userId: "owner-1",
      clerkUserId: "clerk-owner-1",
    });
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });

  it("does not force signing from the viewer's flag when the shared target owner is disabled", async () => {
    vi.mocked(isComputeTargetSigningSupportedForUser).mockImplementation(
      async (identity) => identity.userId === "user-1"
    );
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      userId: "owner-1",
      isSharedWithOrg: true,
      capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
    } as any);
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      ...mockTarget,
      userId: "owner-1",
      user: { clerkId: "clerk-owner-1", firstName: "Owner", lastName: "One" },
    } as any);
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
    expect(isComputeTargetSigningSupportedForUser).toHaveBeenCalledWith({
      userId: "owner-1",
      clerkUserId: "clerk-owner-1",
    });
  });

  it.each([
    ["missing", undefined],
    ["false", false],
    ["malformed string", "true"],
  ])("accepts unsigned legacy commands when commandSigningRequired is %s", async (_label, commandSigningRequired) => {
    vi.mocked(isComputeTargetSigningSupportedForUser).mockResolvedValue(true);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        ...(commandSigningRequired === undefined
          ? {}
          : {
              [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: commandSigningRequired,
            }),
      },
    } as any);
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
  });

  it("rejects signed commands when the browser key is no longer registered", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget as any
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
  ])("rejects the reserved browser-key internal %s", async (_label, override) => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget as any
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
  });

  it.each([
    ["false", false],
    ["missing", undefined],
  ])("accepts and relays valid signed commands when commandSigningRequired is %s", async (_label, commandSigningRequired) => {
    vi.mocked(isComputeTargetSigningSupportedForUser).mockResolvedValue(true);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        ...(commandSigningRequired === undefined
          ? {}
          : {
              [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: commandSigningRequired,
            }),
      },
    } as any);
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
      expect.anything()
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
  });

  it("expires signed commands when relay delivery reports the target offline", async () => {
    vi.mocked(isComputeTargetSigningSupportedForUser).mockResolvedValue(true);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
    } as any);
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

describe("POST /compute-targets/:id/results", () => {
  it("publishes one-shot result payloads", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      mockTarget as any
    );
    vi.mocked(computeTargetsService.heartbeat).mockResolvedValue(true);
    vi.mocked(desktopCommandStore.findCommandIdByOperationId).mockResolvedValue(
      "cmd-1"
    );

    const response = await resultsPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "op-2",
          result: { ok: true },
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    expect(relayEventBus.publishResult).toHaveBeenCalledWith("op-2", {
      operationId: "op-2",
      result: { ok: true },
      done: true,
      sequence: undefined,
    });
  });

  it("returns not found when target is not owned", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);

    const response = await resultsPOST(
      createMockRequest({
        method: "POST",
        body: {
          operationId: "op-2",
          result: { ok: true },
        },
      }),
      createMockRouteContext({ id: "target-2" })
    );

    expect(response.status).toBe(404);
  });
});
