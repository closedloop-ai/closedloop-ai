import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  INTERNAL_SECRET,
  makeSocketEventRequest,
  mockAuthContext,
  mockTarget,
} from "./utils/test-fixtures";

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

const mockNewTarget = { ...mockTarget, id: "new-target-2" };

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.updateOwned).mockResolvedValue(null);
  vi.mocked(computeTargetsService.register).mockResolvedValue(mockNewTarget);
  vi.mocked(computeTargetsService.setOnlineState).mockResolvedValue(true);
  vi.mocked(
    desktopCommandStore.listNonTerminalDispatchCommands
  ).mockResolvedValue([]);
  vi.mocked(relayEventBus.clearOperationBacklog).mockImplementation(vi.fn());
});

describe("POST /internal/relay/socket-event — ownership isolation on desktop.hello", () => {
  it("registers a new target when computeTargetId belongs to a different user", async () => {
    const request = makeSocketEventRequest(
      "desktop.hello",
      {
        machineName: mockTarget.machineName,
        platform: mockTarget.platform,
        computeTargetId: "other-user-target-id",
        supportedOperations: mockTarget.supportedOperations,
      },
      { auth: mockAuthContext }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(vi.mocked(computeTargetsService.updateOwned)).toHaveBeenCalledWith(
      "other-user-target-id",
      mockAuthContext.organizationId,
      mockAuthContext.userId,
      expect.any(Object)
    );

    expect(vi.mocked(computeTargetsService.register)).toHaveBeenCalledTimes(1);

    const body = await response.json();
    expect(body.targetId).toBe("new-target-2");
  });

  it("calls register with the requesting user's organizationId and userId", async () => {
    const request = makeSocketEventRequest(
      "desktop.hello",
      {
        machineName: mockTarget.machineName,
        platform: mockTarget.platform,
        computeTargetId: "other-user-target-id",
        supportedOperations: mockTarget.supportedOperations,
      },
      { auth: mockAuthContext }
    );

    await POST(request);

    expect(vi.mocked(computeTargetsService.register)).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.any(Object)
    );
  });
});
