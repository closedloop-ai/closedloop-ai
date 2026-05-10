import { ApiKeySource, withDb } from "@repo/database";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeysService } from "@/app/api-keys/service";
import { POST } from "@/app/compute-targets/[id]/loops/[loopId]/execution-credentials/route";
import { usersService } from "@/app/users/service";
import {
  getDesktopManagedPopFailure,
  verifyDesktopManagedPop,
} from "@/lib/auth/desktop-managed-pop";
import { buildDesktopLoopExecutionCredentials } from "@/lib/loops/loop-orchestrator";

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
  },
  withDb: {
    tx: vi.fn(),
  },
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    verifyKeyWithMetadata: vi.fn(),
    touchLastUsedAt: vi.fn(),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  verifyDesktopManagedPop: vi.fn(),
  getDesktopManagedPopFailure: vi.fn(),
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  buildDesktopLoopExecutionCredentials: vi.fn(),
}));

const TARGET_ID = "0196b1bb-7a00-7000-8000-000000000001";
const LOOP_ID = "0196b1bb-7a00-7000-8000-000000000002";
const COMMAND_ID = "0196b1bb-7a00-7000-8000-000000000003";

describe("loop execution credentials route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      boundPublicKey: "pem",
      gatewayId: "gateway-1",
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(apiKeysService.touchLastUsedAt).mockResolvedValue(undefined);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user-1",
      active: true,
      clerkId: "clerk-user-1",
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(verifyDesktopManagedPop).mockReturnValue({
      accepted: true,
      enforceEligible: true,
      mode: "enforce",
      reason: "passed",
    });
    vi.mocked(getDesktopManagedPopFailure).mockReturnValue(null);
    vi.mocked(buildDesktopLoopExecutionCredentials).mockResolvedValue({
      loopId: LOOP_ID,
    });
  });

  it("rejects browser and non-Desktop callers before credential lookup", async () => {
    const response = await POST(makeRequest({ authorization: null }), {
      params: Promise.resolve({ id: TARGET_ID, loopId: LOOP_ID }),
    });

    expect(response.status).toBe(401);
    expect(withDb.tx).not.toHaveBeenCalled();
  });

  it("requires a Desktop-managed API key with PoP", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["write"],
      source: "USER_CREATED",
      boundPublicKey: null,
      gatewayId: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: TARGET_ID, loopId: LOOP_ID }),
    });

    expect(response.status).toBe(403);
    expect(withDb.tx).not.toHaveBeenCalled();
  });

  it("atomically consumes credentials only for a gateway-bound loop intent command", async () => {
    const tx = makeCredentialTx();
    vi.mocked(withDb.tx).mockImplementation((callback) =>
      callback(tx as never)
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: TARGET_ID, loopId: LOOP_ID }),
    });

    expect(response.status).toBe(200);
    expect(tx.computeTarget.findFirst).toHaveBeenCalledWith({
      where: {
        id: TARGET_ID,
        organizationId: "org-1",
        userId: "user-1",
        gatewayId: "gateway-1",
      },
      select: { id: true },
    });
    expect(tx.loop.findFirst).toHaveBeenCalledWith({
      where: {
        id: LOOP_ID,
        organizationId: "org-1",
        computeTargetId: TARGET_ID,
      },
      select: { id: true },
    });
    expect(tx.loopExecutionCredentialConsumption.create).toHaveBeenCalledWith({
      data: {
        commandId: COMMAND_ID,
        loopId: LOOP_ID,
        computeTargetId: TARGET_ID,
        gatewayId: "gateway-1",
        action: "loop.launch",
      },
    });
    expect(buildDesktopLoopExecutionCredentials).toHaveBeenCalledWith({
      loopId: LOOP_ID,
      organizationId: "org-1",
      action: "loop.launch",
    });
  });

  it("rejects second durable consumption for the same command", async () => {
    const tx = makeCredentialTx();
    tx.loopExecutionCredentialConsumption.create.mockRejectedValue({
      code: "P2002",
    });
    vi.mocked(withDb.tx).mockImplementation((callback) =>
      callback(tx as never)
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: TARGET_ID, loopId: LOOP_ID }),
    });

    expect(response.status).toBe(409);
    expect(buildDesktopLoopExecutionCredentials).not.toHaveBeenCalled();
  });
});

function makeRequest(input?: { authorization?: string | null }): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (input?.authorization !== null) {
    headers.set("authorization", input?.authorization ?? "Bearer sk_live_test");
  }
  return new Request(
    `https://api.test/compute-targets/${TARGET_ID}/loops/${LOOP_ID}/execution-credentials`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ commandId: COMMAND_ID }),
    }
  ) as NextRequest;
}

function makeCredentialTx() {
  return {
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    },
    loop: {
      findFirst: vi.fn().mockResolvedValue({ id: LOOP_ID }),
    },
    desktopCommand: {
      findFirst: vi.fn().mockResolvedValue({
        id: COMMAND_ID,
        operationId: "symphony_loop",
        requestPayload: {
          path: "/api/gateway/symphony/loop",
          body: { loopId: LOOP_ID, userIntent: { loopId: LOOP_ID } },
        },
      }),
    },
    loopExecutionCredentialConsumption: {
      create: vi.fn().mockResolvedValue({ commandId: COMMAND_ID }),
    },
  };
}
