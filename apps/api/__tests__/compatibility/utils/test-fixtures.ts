import {
  type ComputeTarget,
  DesktopSecurityStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { expect, vi } from "vitest";
import { PROTOCOL_VERSION } from "@/lib/desktop-gateway-types";

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      createFromRelayOperation: vi.fn(),
      findCommandIdByOperationId: vi.fn(),
      ingestCommandEvent: vi.fn(),
    },
  };
});

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
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

export const mockTarget: ComputeTarget = {
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "test-machine",
  platform: "darwin",
  gatewayId: "550e8400-e29b-41d4-a716-446655440000",
  capabilities: {},
  supportedOperations: ["symphony_chat"],
  lastSeenAt: new Date(),
  isOnline: true,
  isSharedWithOrg: false,
  security: {
    status: DesktopSecurityStatus.Protected,
    reason: "BOUND_DESKTOP_MANAGED_KEY",
    upgradeSupported: false,
  },
  selectedHarness: HarnessType.Claude,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const mockAuthContext = {
  organizationId: "org-1",
  userId: "user-1",
};

export const mockGatewayOwnerAuthContext = {
  organizationId: "org-1",
  userId: "user_db_1",
  clerkUserId: "clerk_user_1",
};

export const INTERNAL_SECRET = "test-internal-secret";

export function makeEnvelope<T extends Record<string, unknown>>(
  payload: T
): T & {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: ReturnType<typeof expect.any>;
  timestamp: ReturnType<typeof expect.any>;
} {
  return {
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    messageId: expect.any(String),
    timestamp: expect.any(String),
  };
}

export function makeSocketEventRequest(
  event: string,
  payload: Record<string, unknown>,
  opts?: {
    targetId?: string;
    auth?: Record<string, unknown>;
  }
): Request {
  return new Request("http://localhost:3002/api/socket-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_SECRET,
    },
    body: JSON.stringify({
      event,
      payload,
      targetId: opts?.targetId,
      auth: opts?.auth ?? mockAuthContext,
    }),
  });
}
