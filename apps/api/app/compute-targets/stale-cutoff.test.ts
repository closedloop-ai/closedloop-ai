import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOCKET_HEARTBEAT_INTERVAL_MS } from "@/lib/desktop-gateway-types";
import { COMPUTE_TARGET_STALE_MS, computeTargetsService } from "./service";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  loadActiveDesktopManagedGatewayIds: vi.fn(),
}));

const FIXED_NOW = new Date("2026-09-12T00:00:00.000Z");

type StaleUpdateArgs = { where: { lastSeenAt: { lt: Date } } };

describe("COMPUTE_TARGET_STALE_MS", () => {
  it("is ninety seconds", () => {
    expect(COMPUTE_TARGET_STALE_MS).toBe(90_000);
  });

  it("outlasts a missed check-in on each transport's own cadence", () => {
    expect(COMPUTE_TARGET_STALE_MS).toBeGreaterThan(
      2 * RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS
    );
    expect(COMPUTE_TARGET_STALE_MS).toBeGreaterThan(
      2 * SOCKET_HEARTBEAT_INTERVAL_MS
    );
  });
});

describe("markStaleTargetsOffline", () => {
  let capturedArgs: StaleUpdateArgs | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    capturedArgs = undefined;
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        computeTarget: {
          updateMany: (args: StaleUpdateArgs) => {
            capturedArgs = args;
            return { count: 0 };
          },
        },
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not select a direct-socket target that missed one heartbeat", async () => {
    await computeTargetsService.markStaleTargetsOffline();

    if (!capturedArgs) {
      throw new Error("markStaleTargetsOffline did not issue an updateMany");
    }
    const cutoff = capturedArgs.where.lastSeenAt.lt;
    expect(FIXED_NOW.getTime() - cutoff.getTime()).toBe(90_000);

    const missedOneDirectHeartbeat =
      FIXED_NOW.getTime() - 2 * SOCKET_HEARTBEAT_INTERVAL_MS;
    expect(missedOneDirectHeartbeat).toBeGreaterThan(cutoff.getTime());
  });
});
