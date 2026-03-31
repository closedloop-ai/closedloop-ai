/**
 * Compatibility test: compute target registration flow.
 *
 * Validates that when a desktop.hello event arrives without a computeTargetId,
 * the route calls computeTargetsService.register and returns a hello.ack with
 * the newly assigned computeTargetId.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports that transitively pull in the mocked modules) ---

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      ...original.computeTargetsService,
      register: vi.fn(),
      updateOwned: vi.fn(),
      setOnlineState: vi.fn(),
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
      listNonTerminalDispatchCommands: vi.fn(),
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
      clearOperationBacklog: vi.fn(),
    },
  };
});

// --- Imports (after mocks) ---

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  INTERNAL_SECRET,
  makeSocketEventRequest,
  mockTarget,
} from "./utils/test-fixtures";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const newTarget = { ...mockTarget, id: "new-target-1" };

const helloPayload = {
  machineName: "new-machine",
  platform: "linux",
  pluginVersion: "2.0.0",
  supportedOperations: ["symphony_chat", "git_action"],
  maxInFlightCommands: 3,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.register).mockResolvedValue(newTarget);
  vi.mocked(computeTargetsService.updateOwned).mockResolvedValue(null);
  vi.mocked(
    desktopCommandStore.listNonTerminalDispatchCommands
  ).mockResolvedValue([]);
  vi.mocked(relayEventBus.clearOperationBacklog).mockImplementation(vi.fn());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /internal/relay/socket-event — compute target registration", () => {
  it("returns HTTP 200", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("calls computeTargetsService.register with the correct arguments", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    await POST(request);

    expect(computeTargetsService.register).toHaveBeenCalledWith(
      mockTarget.organizationId,
      mockTarget.userId,
      expect.objectContaining({
        machineName: "new-machine",
        platform: "linux",
        pluginVersion: "2.0.0",
        supportedOperations: ["symphony_chat", "git_action"],
      })
    );
  });

  it("returns the newly assigned targetId in the response body", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    const response = await POST(request);
    const result = await response.json();

    expect(result.targetId).toBe("new-target-1");
  });

  it("emits desktop.hello.ack with the new computeTargetId", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    const response = await POST(request);
    const result = await response.json();

    expect(result.emit[0].event).toBe("desktop.hello.ack");
    expect(result.emit[0].payload).toEqual(
      expect.objectContaining({
        computeTargetId: "new-target-1",
      })
    );
  });
});
