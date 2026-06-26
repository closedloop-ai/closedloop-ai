import { BROWSER_KEY_UNREGISTERED_ERROR_CODE } from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as cancelPOST } from "@/app/loops/[id]/cancel/route";
import { DELETE as loopDELETE } from "@/app/loops/[id]/route";
import { loopsService } from "@/app/loops/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import { stopDesktopLoop } from "@/lib/loops/loop-desktop";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
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

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn(),
    cancel: vi.fn(),
    addEvent: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-desktop", () => ({
  stopDesktopLoop: vi.fn(),
}));

vi.mock("@/lib/loops/loop-ecs", () => ({
  stopLoopTask: vi.fn(),
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: {
    publish: vi.fn(),
  },
}));

vi.mock("@/lib/browser-command-public-key-enforcement", () => ({
  enforceRegisteredBrowserPublicKey: vi.fn(),
}));

const desktopLoop = {
  id: "loop-1",
  organizationId: "org-1",
  computeTargetId: "target-1",
  containerId: null,
};

describe("loop cancellation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    vi.mocked(loopsService.findById).mockResolvedValue(desktopLoop as any);
    vi.mocked(loopsService.cancel).mockResolvedValue({
      ...desktopLoop,
      status: "CANCELLED",
    } as any);
    vi.mocked(loopsService.addEvent).mockResolvedValue({} as any);
    vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(null);
  });

  it("keeps DELETE /loops/:id DB cancellation best-effort when Desktop kill fails", async () => {
    vi.mocked(stopDesktopLoop).mockRejectedValue(
      new Error("Command signing is required for this compute target")
    );

    const response = await loopDELETE(
      createMockRequest({ method: "DELETE" }),
      createMockRouteContext({ id: "loop-1" })
    );

    expect(response.status).toBe(200);
    expect(stopDesktopLoop).toHaveBeenCalledWith(
      "loop-1",
      "target-1",
      undefined
    );
    expect(loopsService.cancel).toHaveBeenCalledWith("loop-1", "org-1");
    expect(loopsService.addEvent).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      expect.objectContaining({ type: "cancelled" })
    );
    expect(loopEventBus.publish).toHaveBeenCalledWith(
      "loop-1",
      expect.objectContaining({ type: "cancelled" })
    );
  });

  it("keeps POST /loops/:id/cancel DB cancellation when signed kill delivery fails", async () => {
    vi.mocked(stopDesktopLoop).mockRejectedValue(
      new Error("Relay dispatch not delivered: target_offline")
    );

    const response = await cancelPOST(
      createMockRequest({
        method: "POST",
        body: {
          userIntentSignature: {
            commandId: "0196b1bb-7a00-7000-8000-000000000010",
            signature: "signature",
            signaturePayload: "payload",
            publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
            body: { loopId: "loop-1", action: "loop.kill" },
          },
        },
      }),
      createMockRouteContext({ id: "loop-1" })
    );

    expect(response.status).toBe(200);
    expect(stopDesktopLoop).toHaveBeenCalledWith("loop-1", "target-1", {
      commandId: "0196b1bb-7a00-7000-8000-000000000010",
      signature: "signature",
      signaturePayload: "payload",
      publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
      body: { loopId: "loop-1", action: "loop.kill" },
    });
    expect(loopsService.cancel).toHaveBeenCalledWith("loop-1", "org-1");
  });

  it("rejects a signed cancel intent whose browser key is unregistered", async () => {
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

    const response = await cancelPOST(
      createMockRequest({
        method: "POST",
        body: {
          userIntentSignature: {
            commandId: "0196b1bb-7a00-7000-8000-000000000010",
            signature: "signature",
            signaturePayload: "payload",
            publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
            body: { loopId: "loop-1", action: "loop.kill" },
          },
        },
      }),
      createMockRouteContext({ id: "loop-1" })
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
      publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
    });
    expect(loopsService.findById).not.toHaveBeenCalled();
    expect(stopDesktopLoop).not.toHaveBeenCalled();
    expect(loopsService.cancel).not.toHaveBeenCalled();
  });

  it("rejects a signed cancel intent for a different loop", async () => {
    const response = await cancelPOST(
      createMockRequest({
        method: "POST",
        body: {
          userIntentSignature: {
            commandId: "0196b1bb-7a00-7000-8000-000000000010",
            signature: "signature",
            signaturePayload: "payload",
            publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
            body: { loopId: "loop-other", action: "loop.kill" },
          },
        },
      }),
      createMockRouteContext({ id: "loop-1" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Signed cancel intent does not match loop",
    });
    expect(stopDesktopLoop).not.toHaveBeenCalled();
    expect(loopsService.cancel).not.toHaveBeenCalled();
  });
});
