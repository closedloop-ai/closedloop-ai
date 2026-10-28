import {
  type ComputeTarget,
  DesktopSecurityStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { expect, vi } from "vitest";
import { PROTOCOL_VERSION } from "@/lib/desktop-gateway-types";
import { buildDesktopServerCapabilities } from "@/lib/desktop-server-capabilities";

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
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

/**
 * `desktop.hello.ack` envelope. Separate from `makeEnvelope` because only the
 * hello ack carries the capability advertisement — `desktop.command.event.ack`
 * uses the bare envelope, and folding the field into the shared helper would
 * assert it on a frame that never emits it.
 *
 * ISS-8022 retired the `desktop-agent-session-sync` feature flag, which is what
 * made `buildDesktopServerCapabilities` return a value unconditionally; before
 * that it returned `undefined` for an unsigned target and the key was spread
 * away. Derived from the producer rather than restated, so adding a capability
 * does not redden six unrelated handshake assertions — what this pins is that
 * the ack still CARRIES the advertisement a version-skewed desktop negotiates
 * on. Capabilities have been added to that payload since ISS-8022 (ISS-5850,
 * ISS-7896), and each one would have re-reddened all six of these cases had the
 * expectation been written out as a literal.
 *
 * What derivation alone CANNOT catch is a required capability being removed or
 * renamed: emitted and expected move together and every case stays green while a
 * shipped Desktop loses the handshake. That half is
 * {@link REQUIRED_DESKTOP_SERVER_CAPABILITIES}, asserted independently in
 * `tier2-command-dispatch.test.ts`.
 */
export function makeHelloAckEnvelope<T extends Record<string, unknown>>(
  payload: T
) {
  return makeEnvelope({
    ...payload,
    // No fixture in this tier registers a signing-capable target, so the one
    // conditional capability is off. A fixture that does gets the argument then.
    serverCapabilities: buildDesktopServerCapabilities({
      commandSigningSupported: false,
    }),
  });
}

/**
 * The capabilities a version-skewed Desktop negotiates on, as LITERALS.
 *
 * Deliberately a copy and not an import of `buildDesktopServerCapabilities`:
 * this tier's whole job is to restate the wire contract INDEPENDENTLY of the
 * producer, so that removing or renaming one of these fails here even though
 * the emitted payload and a derived expectation would change together.
 *
 * A SUPERSET check, never equality — an ADDITIVE capability is exactly what the
 * Cross-Repo Compatibility rules permit and must not redden this. Signing is
 * absent on purpose: it is the one conditional capability, and it has its own
 * opt-in case rather than a row here.
 */
export const REQUIRED_DESKTOP_SERVER_CAPABILITIES = {
  agentSessionSync: true,
  agentSessionSyncCompression: true,
  agentSessionSyncActivityChunking: true,
  agentSessionSyncMonitoredActivity: true,
  agentSessionSyncSpanExtent: true,
  agentSessionSyncHumanTurnTimestamps: true,
} as const;
