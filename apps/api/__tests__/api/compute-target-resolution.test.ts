import {
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { PreferredComputeMode } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { resolveComputeTarget } from "@/lib/loops/compute-target-resolver";

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      register: vi.fn(),
      listAvailableForOrg: vi.fn(),
      heartbeat: vi.fn(),
      updateOwned: vi.fn(),
      deleteOwned: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      findOwnedById: vi.fn(),
      findAccessibleById: vi.fn(),
    },
  };
});

const makeTarget = (overrides: Partial<ComputeTarget> = {}): ComputeTarget => ({
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "Daniel-MBP",
  platform: "darwin",
  capabilities: {},
  supportedOperations: ["symphony_chat"],
  lastSeenAt: new Date(),
  isOnline: true,
  isSharedWithOrg: false,
  selectedHarness: HarnessType.Claude,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const ORG_ID = "org-1";
const USER_ID = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveComputeTarget — no hint (auto-select)", () => {
  it("returns resolved with the single online target", async () => {
    const target = makeTarget();
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      target,
    ]);

    const result = await resolveComputeTarget(ORG_ID, USER_ID);

    expect(result).toEqual({ reason: "resolved", target });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID
    );
  });

  it("returns no_targets when owner has no compute targets", async () => {
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([]);

    const result = await resolveComputeTarget(ORG_ID, USER_ID);

    expect(result).toEqual({ reason: "no_targets" });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("returns no_online_targets (ECS fallback signal) when all targets are offline", async () => {
    const offlineTarget = makeTarget({ isOnline: false });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      offlineTarget,
    ]);

    const result = await resolveComputeTarget(ORG_ID, USER_ID);

    expect(result).toEqual({ reason: "no_online_targets" });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("auto-selects most recently active target when multiple online and no preferred target set", async () => {
    const older = makeTarget({
      id: "target-1",
      lastSeenAt: new Date("2024-01-01T10:00:00Z"),
    });
    const newer = makeTarget({
      id: "target-2",
      machineName: "Other-MBP",
      lastSeenAt: new Date("2024-01-02T10:00:00Z"),
    });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      older,
      newer,
    ]);

    const result = await resolveComputeTarget(ORG_ID, USER_ID);

    expect(result).toEqual({ reason: "resolved", target: newer });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });
});

describe("resolveComputeTarget — with hint (computeTargetIdHint)", () => {
  it("returns resolved when the hinted target is online and owned by user", async () => {
    const target = makeTarget();
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(target);

    const result = await resolveComputeTarget(ORG_ID, USER_ID, "target-1");

    expect(result).toEqual({ reason: "resolved", target });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledOnce();
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "target-1",
      ORG_ID,
      USER_ID
    );
  });

  it("returns hint_offline when the hinted target exists but is offline", async () => {
    const offlineTarget = makeTarget({ isOnline: false });
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      offlineTarget
    );

    const result = await resolveComputeTarget(ORG_ID, USER_ID, "target-1");

    expect(result).toEqual({ reason: "hint_offline", target: offlineTarget });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledOnce();
  });

  it("returns hint_not_found when the hinted target does not exist", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(null);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      "nonexistent-target"
    );

    expect(result).toEqual({ reason: "hint_not_found" });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledOnce();
    expect(computeTargetsService.findAccessibleById).toHaveBeenCalledOnce();
  });

  it("resolves shared target when not owned but shared with org", async () => {
    const sharedTarget = makeTarget({
      id: "shared-target",
      userId: "other-user",
      isSharedWithOrg: true,
    });
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      sharedTarget
    );

    const result = await resolveComputeTarget(ORG_ID, USER_ID, "shared-target");

    expect(result).toEqual({ reason: "resolved", target: sharedTarget });
    expect(computeTargetsService.findAccessibleById).toHaveBeenCalledWith(
      "shared-target",
      ORG_ID,
      USER_ID
    );
  });

  it("returns hint_not_found for unshared cross-user target", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(null);

    const result = await resolveComputeTarget(
      ORG_ID,
      "different-user",
      "target-1"
    );

    expect(result).toEqual({ reason: "hint_not_found" });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "target-1",
      ORG_ID,
      "different-user"
    );
  });
});

describe("resolveComputeTarget — preferredComputeMode parameter", () => {
  it("LOCAL + one online target -> resolved", async () => {
    const target = makeTarget();
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      target,
    ]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      PreferredComputeMode.LOCAL
    );

    expect(result).toEqual({ reason: "resolved", target });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID
    );
  });

  it("LOCAL + zero registered targets -> no_targets (fallbackToCloud does not apply to zero-registered case)", async () => {
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      PreferredComputeMode.LOCAL,
      true
    );

    expect(result).toEqual({ reason: "no_targets" });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("LOCAL + all offline + fallbackToCloud=true -> cloud_resolved", async () => {
    const offlineTarget = makeTarget({ isOnline: false });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      offlineTarget,
    ]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      PreferredComputeMode.LOCAL,
      true
    );

    expect(result).toEqual({ reason: "cloud_resolved" });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("CLOUD preference -> cloud_resolved without querying targets", async () => {
    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      PreferredComputeMode.CLOUD
    );

    expect(result).toEqual({ reason: "cloud_resolved" });
    expect(computeTargetsService.listAvailableForOrg).not.toHaveBeenCalled();
    expect(computeTargetsService.findOwnedById).not.toHaveBeenCalled();
  });

  it("LOCAL + multiple online targets -> auto-selects most recently active", async () => {
    const older = makeTarget({
      id: "target-1",
      lastSeenAt: new Date("2024-01-01T10:00:00Z"),
    });
    const newer = makeTarget({
      id: "target-2",
      machineName: "Other-MBP",
      lastSeenAt: new Date("2024-01-02T10:00:00Z"),
    });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      older,
      newer,
    ]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      PreferredComputeMode.LOCAL
    );

    expect(result).toEqual({ reason: "resolved", target: newer });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("cross-user hint not owned or shared -> hint_not_found", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(null);

    const result = await resolveComputeTarget(
      ORG_ID,
      "different-user",
      "target-owned-by-other",
      PreferredComputeMode.LOCAL
    );

    expect(result).toEqual({ reason: "hint_not_found" });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledOnce();
    expect(computeTargetsService.findAccessibleById).toHaveBeenCalledOnce();
  });
});

describe("resolveComputeTarget — preferredComputeTargetId parameter", () => {
  it("auto-selects preferred target when multiple online and preferred target is online", async () => {
    const preferred = makeTarget({
      id: "preferred-target",
      machineName: "Preferred-MBP",
      lastSeenAt: new Date("2024-01-01T10:00:00Z"),
    });
    const other = makeTarget({
      id: "other-target",
      machineName: "Other-MBP",
      lastSeenAt: new Date("2024-01-02T10:00:00Z"),
    });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      preferred,
      other,
    ]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      undefined,
      undefined,
      "preferred-target"
    );

    expect(result).toEqual({ reason: "resolved", target: preferred });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("falls back to lastSeenAt sort when preferred target is not among online targets", async () => {
    const older = makeTarget({
      id: "target-1",
      lastSeenAt: new Date("2024-01-01T10:00:00Z"),
    });
    const newer = makeTarget({
      id: "target-2",
      machineName: "Other-MBP",
      lastSeenAt: new Date("2024-01-02T10:00:00Z"),
    });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      older,
      newer,
    ]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      undefined,
      undefined,
      "offline-or-absent-target"
    );

    expect(result).toEqual({ reason: "resolved", target: newer });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });

  it("falls back to lastSeenAt sort when no preferred target set and multiple online", async () => {
    const older = makeTarget({
      id: "target-1",
      lastSeenAt: new Date("2024-01-01T10:00:00Z"),
    });
    const newer = makeTarget({
      id: "target-2",
      machineName: "Other-MBP",
      lastSeenAt: new Date("2024-01-02T10:00:00Z"),
    });
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([
      older,
      newer,
    ]);

    const result = await resolveComputeTarget(
      ORG_ID,
      USER_ID,
      undefined,
      undefined,
      undefined,
      undefined
    );

    expect(result).toEqual({ reason: "resolved", target: newer });
    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
  });
});

describe("resolveComputeTarget — service call counts", () => {
  it("calls listAvailableForOrg exactly once and never findOwnedById when no hint provided", async () => {
    vi.mocked(computeTargetsService.listAvailableForOrg).mockResolvedValue([]);

    await resolveComputeTarget(ORG_ID, USER_ID);

    expect(computeTargetsService.listAvailableForOrg).toHaveBeenCalledOnce();
    expect(computeTargetsService.findOwnedById).not.toHaveBeenCalled();
  });

  it("calls findOwnedById then findAccessibleById when hint provided and not owned", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(null);

    await resolveComputeTarget(ORG_ID, USER_ID, "target-1");

    expect(computeTargetsService.findOwnedById).toHaveBeenCalledOnce();
    expect(computeTargetsService.findAccessibleById).toHaveBeenCalledOnce();
    expect(computeTargetsService.listAvailableForOrg).not.toHaveBeenCalled();
  });
});
