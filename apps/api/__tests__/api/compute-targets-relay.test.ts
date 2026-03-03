import { vi } from "vitest";
import { POST as dispatchPOST } from "@/app/compute-targets/[id]/operations/route";
import { POST as resultsPOST } from "@/app/compute-targets/[id]/results/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import type { AuthContext } from "@/lib/auth/with-auth";
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
      createFromRelayOperation: vi.fn(),
      findCommandIdByOperationId: vi.fn(),
      ingestCommandEvent: vi.fn(),
    },
  };
});

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(desktopCommandStore.createFromRelayOperation).mockResolvedValue({
    command: {
      commandId: "cmd-1",
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
