/**
 * Compatibility test: compute-target dispatch streaming.
 *
 * Validates that POST /compute-targets/:id/operations:
 * 1. Returns HTTP 200 for a valid RelayOperationDispatchRequest
 * 2. Calls relayEventBus.publishOperation with the target ID and operation
 * 3. Returns a response body containing commandId
 */

import { vi } from "vitest";

// --- Mocks (must come before imports that pull in the mocked modules) ---

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: unknown, req: unknown, params: unknown) => unknown) =>
    async (
      request: unknown,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(
        { user: { id: "user-1", organizationId: "org-1" } },
        request,
        context.params
      ),
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

// --- Imports (after mocks) ---

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/compute-targets/[id]/operations/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import { mockTarget } from "./utils/test-fixtures";

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

function makeOperationsRequest(
  targetId: string,
  body: Record<string, unknown>
): {
  request: NextRequest;
  context: { params: Promise<Record<string, string>> };
} {
  const request = new NextRequest(
    `http://localhost:3002/api/compute-targets/${targetId}/operations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return {
    request,
    context: { params: Promise.resolve({ id: targetId }) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /compute-targets/:id/operations — dispatch streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.markStaleTargetsOffline).mockResolvedValue(
      0
    );
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      mockTarget as any
    );
    vi.mocked(desktopCommandStore.createFromRelayOperation).mockResolvedValue({
      command: { commandId: "cmd-1" },
      deduped: false,
    } as any);
    vi.mocked(relayEventBus.publishOperation).mockReturnValue({
      deliveredToSubscriber: true,
    });
  });

  it("returns HTTP 200 for a valid streaming dispatch request", async () => {
    const { request, context } = makeOperationsRequest("target-1", {
      operationId: "op-1",
      operation: "symphony_chat",
      params: { ticketId: "ENG-1" },
      streaming: true,
    });

    const response = await POST(request, context);

    expect(response.status).toBe(200);
  });

  it("calls relayEventBus.publishOperation with the target ID and operation", async () => {
    const { request, context } = makeOperationsRequest("target-1", {
      operationId: "op-1",
      operation: "symphony_chat",
      params: { ticketId: "ENG-1" },
      streaming: true,
    });

    await POST(request, context);

    expect(vi.mocked(relayEventBus.publishOperation)).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({ operationId: "op-1" })
    );
  });

  it("response body contains commandId injected into operation params", async () => {
    const { request, context } = makeOperationsRequest("target-1", {
      operationId: "op-1",
      operation: "symphony_chat",
      params: { ticketId: "ENG-1" },
      streaming: true,
    });

    await POST(request, context);

    expect(vi.mocked(relayEventBus.publishOperation)).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        params: expect.objectContaining({ commandId: "cmd-1" }),
      })
    );
  });

  it("response body data contains queued: true", async () => {
    const { request, context } = makeOperationsRequest("target-1", {
      operationId: "op-1",
      operation: "symphony_chat",
      params: { ticketId: "ENG-1" },
      streaming: true,
    });

    const response = await POST(request, context);
    const json = await response.json();

    expect(json.success).toBe(true);
    expect(json.data).toEqual(expect.objectContaining({ queued: true }));
  });
});
