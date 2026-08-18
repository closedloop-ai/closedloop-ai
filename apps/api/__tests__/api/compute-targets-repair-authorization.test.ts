import {
  HEALTH_CHECK_REPAIR_OPERATION_ID,
  HEALTH_CHECK_REPAIR_PATH,
} from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as commandsPOST } from "@/app/compute-targets/[id]/commands/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import { env } from "@/env";
import type { AuthContext } from "@/lib/auth/with-auth";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import {
  CommandSigningRequirementStatus,
  resolveCommandSigningRequirement,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  HEALTH_CHECK_REPAIR_NOT_OWNED_ERROR_CODE,
  isHealthCheckRepairCommand,
} from "@/lib/health-check-repair-command";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

/**
 * The ownership boundary for System Check Repair (ISS-5389 review).
 *
 * It lives in its own file rather than in compute-targets-relay.test.ts, which
 * is already over the 1,000-line ceiling and is grandfathered shrink-only.
 *
 * The app's gateway-relay forwarder refuses a Repair against someone else's
 * target, but that is UX only. This route authorizes with `findAccessibleById`,
 * which intentionally includes org-shared targets, and its validator accepts any
 * `/api/gateway/*` path in the body, so anyone holding a session token could
 * otherwise POST the command directly. This is the check that actually holds.
 */

let mockAuthContext: AuthContext;
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/server", () => ({
  analytics: { isFeatureEnabled: mockIsFeatureEnabled },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    // biome-ignore lint/suspicious/noExplicitAny: test double for the auth wrapper
    (handler: any) => async (request: any, context: any) =>
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
    },
  };
});

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: vi.fn().mockResolvedValue({ id: "user-1", active: true }),
  },
}));

vi.mock("@/lib/relay-event-bus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/relay-event-bus")>();
  return {
    ...original,
    relayEventBus: { ...original.relayEventBus, publishOperation: vi.fn() },
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
    resolveCommandSigningRequirement: vi.fn(),
  };
});

vi.mock("@/lib/browser-command-public-key-enforcement", () => ({
  enforceRegisteredBrowserPublicKey: vi.fn(),
}));

const OWNER_USER_ID = "user-1";

const mockTarget = {
  id: "target-1",
  organizationId: "org-1",
  userId: OWNER_USER_ID,
  machineName: "machine-1",
  platform: "darwin",
  capabilities: {},
  supportedOperations: [HEALTH_CHECK_REPAIR_OPERATION_ID],
  gatewayId: "gateway-1",
  lastSeenAt: new Date(),
  isOnline: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function repairCommandBody() {
  return {
    operationId: HEALTH_CHECK_REPAIR_OPERATION_ID,
    method: "POST",
    // The relay appends the re-check inputs, so the guard has to normalize the
    // pathname before comparing.
    path: `${HEALTH_CHECK_REPAIR_PATH}?latestVersion=1.2.3`,
    headers: {},
    streaming: false,
  };
}

async function postRepair() {
  return await commandsPOST(
    createMockRequest({ method: "POST", body: repairCommandBody() }),
    createMockRouteContext({ id: "target-1" })
  );
}

describe("POST /compute-targets/:id/commands System Check Repair ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(null);
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      ...mockTarget,
      user: { clerkId: "clerk-user-1" },
      // biome-ignore lint/suspicious/noExplicitAny: partial Prisma row fixture
    } as any);
    vi.mocked(relayEventBus.publishOperation).mockReturnValue({
      deliveredToSubscriber: true,
    });
    vi.mocked(desktopCommandStore.createCommand).mockResolvedValue({
      commandId: "cmd-1",
      // biome-ignore lint/suspicious/noExplicitAny: partial command fixture
    } as any);
    mockAuthContext = createTestAuthContext({
      user: {
        id: OWNER_USER_ID,
        organizationId: "org-1",
        // biome-ignore lint/suspicious/noExplicitAny: partial auth user fixture
      } as any,
    });
    if (env.RELAY_API_URL) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ delivered: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );
    }
  });

  it("rejects a Repair against a target the caller does not own", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      ...mockTarget,
      userId: "someone-else",
      // biome-ignore lint/suspicious/noExplicitAny: partial Prisma row fixture
    } as any);

    const response = await postRepair();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: HEALTH_CHECK_REPAIR_NOT_OWNED_ERROR_CODE,
    });
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });

  it("allows a Repair against a target the caller owns", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      // biome-ignore lint/suspicious/noExplicitAny: partial Prisma row fixture
      mockTarget as any
    );

    const response = await postRepair();

    expect(response.status).not.toBe(403);
    expect(desktopCommandStore.createCommand).toHaveBeenCalled();
  });

  it("classifies a Repair by path even under an unrelated operation id", () => {
    expect(
      isHealthCheckRepairCommand({
        operationId: "health_check",
        path: `${HEALTH_CHECK_REPAIR_PATH}?latestVersion=1.2.3`,
      })
    ).toBe(true);
    expect(
      isHealthCheckRepairCommand({
        operationId: "health_check",
        path: "/api/gateway/health-check",
      })
    ).toBe(false);
  });
});
