import { vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitCommandLifecycleEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitQueueMetric: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/origin", () => ({
  ORIGIN: "test",
}));

const desktopCommandCountSpy = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        desktopCommand: {
          count: desktopCommandCountSpy,
        },
      })
    ),
    { tx: vi.fn() }
  ),
}));

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it } from "vitest";
import { desktopCommandStore } from "@/lib/desktop-command-store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("desktopCommandStore.countCommandsForTarget", () => {
  it("returns the count from the database when matching commands exist", async () => {
    desktopCommandCountSpy.mockResolvedValue(3);

    const result = await desktopCommandStore.countCommandsForTarget(
      "target-1",
      DesktopCommandStatus.Running
    );

    expect(result).toBe(3);
  });

  it("returns 0 when no commands match the given status", async () => {
    desktopCommandCountSpy.mockResolvedValue(0);

    const result = await desktopCommandStore.countCommandsForTarget(
      "target-1",
      DesktopCommandStatus.Queued
    );

    expect(result).toBe(0);
  });

  it("scopes the query by computeTargetId — passes computeTargetId in the where clause", async () => {
    desktopCommandCountSpy.mockResolvedValue(2);

    await desktopCommandStore.countCommandsForTarget(
      "target-specific",
      DesktopCommandStatus.Accepted
    );

    expect(desktopCommandCountSpy).toHaveBeenCalledOnce();
    const { where } = desktopCommandCountSpy.mock.calls[0][0];
    expect(where.computeTargetId).toBe("target-specific");
  });

  it("uses { in: [...] } for the status filter when an array of statuses is provided", async () => {
    desktopCommandCountSpy.mockResolvedValue(5);

    const statuses = [
      DesktopCommandStatus.Accepted,
      DesktopCommandStatus.Running,
    ];

    await desktopCommandStore.countCommandsForTarget("target-1", statuses);

    expect(desktopCommandCountSpy).toHaveBeenCalledOnce();
    const { where } = desktopCommandCountSpy.mock.calls[0][0];
    expect(where.status).toEqual({ in: statuses });
  });

  it("uses the raw string for the status filter when a single status is provided", async () => {
    desktopCommandCountSpy.mockResolvedValue(1);

    await desktopCommandStore.countCommandsForTarget(
      "target-1",
      DesktopCommandStatus.Running
    );

    expect(desktopCommandCountSpy).toHaveBeenCalledOnce();
    const { where } = desktopCommandCountSpy.mock.calls[0][0];
    expect(where.status).toBe(DesktopCommandStatus.Running);
  });
});
