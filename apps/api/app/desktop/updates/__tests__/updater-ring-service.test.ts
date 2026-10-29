/**
 * ISS-9164 — the ring resolver's decision, executed rather than described.
 *
 * Every case drives `resolveRing` against a synthetic request and a stubbed
 * `computeTarget.findUnique`, so a resolver arm that stopped answering would fail
 * here. The database double is a bare `findUnique` because that is the whole read:
 * one indexed lookup selecting one column.
 */
import { DesktopReleaseRing } from "@repo/api/src/types/desktop-release";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPUTE_TARGET_ID = "01a06a86-56fa-7213-ae2d-3f5fe0932ec5";
const OTHER_COMPUTE_TARGET_ID = "01a06a87-4bbd-71ff-b6a4-c259f8073bba";
const INTERNAL_ORGANIZATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CUSTOMER_ORGANIZATION_ID = "019c24db-ffff-7000-8000-ea275fb27470";
/** Written out, not imported: this is the cross-process wire spelling. */
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  logWarn: vi.fn(),
  env: {} as {
    DESKTOP_INTERNAL_RING_TARGETS?: string;
    DESKTOP_INTERNAL_RING_ORGANIZATIONS?: string;
  },
}));

vi.mock("@repo/database", () => ({
  withDb: (
    fn: (db: {
      computeTarget: { findUnique: typeof mocks.findUnique };
    }) => unknown
  ) => fn({ computeTarget: { findUnique: mocks.findUnique } }),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.logWarn, debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@/env", () => ({ env: mocks.env }));

import {
  desktopUpdaterRingService,
  resetDesktopUpdaterRingCacheForTests,
  UnknownComputeTargetMaxEntries,
} from "../updater-ring-service";

function updaterRequest(headers: Record<string, string> = {}): Request {
  return new Request(
    "https://api.closedloop.ai/desktop/updates/latest-mac.yml",
    {
      headers,
    }
  );
}

function attributedRequest(computeTargetId = COMPUTE_TARGET_ID): Request {
  return updaterRequest({ [COMPUTE_TARGET_ID_HEADER]: computeTargetId });
}

/**
 * A distinct valid UUID per index, so an overflow case can exceed the cache's
 * size cap. Hand-built rather than random because the cases assert exact read
 * counts and must be reproducible.
 */
function syntheticComputeTargetId(index: number): string {
  return `01a06a86-56fa-7213-ae2d-${index.toString(16).padStart(12, "0")}`;
}

beforeEach(() => {
  resetDesktopUpdaterRingCacheForTests();
  mocks.findUnique.mockReset();
  mocks.logWarn.mockReset();
  mocks.env.DESKTOP_INTERNAL_RING_TARGETS = undefined;
  mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("desktopUpdaterRingService.resolveRing", () => {
  it("serves the general ring to a build that sends no header, reading no row", async () => {
    const resolution = await desktopUpdaterRingService.resolveRing(
      updaterRequest()
    );

    expect(resolution).toEqual({
      ring: DesktopReleaseRing.General,
      perInstall: false,
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("serves the general ring for an id the database does not know", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution).toEqual({
      ring: DesktopReleaseRing.General,
      perInstall: true,
    });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("serves the general ring for a malformed id without reading a row", async () => {
    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest("not-a-uuid")
    );

    expect(resolution).toEqual({
      ring: DesktopReleaseRing.General,
      perInstall: false,
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("serves the general ring when the lookup throws, logging no id", async () => {
    mocks.findUnique.mockRejectedValue(new Error("pool exhausted"));
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution.ring).toBe(DesktopReleaseRing.General);
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(
      COMPUTE_TARGET_ID
    );
  });

  it("does not cache a lookup failure, so a transient error is not sticky", async () => {
    mocks.findUnique.mockRejectedValueOnce(new Error("pool exhausted"));
    mocks.findUnique.mockResolvedValue({
      organizationId: INTERNAL_ORGANIZATION_ID,
    });
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;

    await desktopUpdaterRingService.resolveRing(attributedRequest());
    const retried = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(retried.ring).toBe(DesktopReleaseRing.Internal);
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("serves the internal ring to a target in an internal organisation", async () => {
    mocks.findUnique.mockResolvedValue({
      organizationId: INTERNAL_ORGANIZATION_ID,
    });
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution).toEqual({
      ring: DesktopReleaseRing.Internal,
      perInstall: true,
    });
  });

  it("serves the general ring to a customer organisation's target", async () => {
    mocks.findUnique.mockResolvedValue({
      organizationId: CUSTOMER_ORGANIZATION_ID,
    });
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution.ring).toBe(DesktopReleaseRing.General);
  });

  it("serves the internal ring to an allow-listed target, reading no row", async () => {
    mocks.env.DESKTOP_INTERNAL_RING_TARGETS = COMPUTE_TARGET_ID;

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution.ring).toBe(DesktopReleaseRing.Internal);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("matches an allow-list entry that carries surrounding whitespace", async () => {
    mocks.env.DESKTOP_INTERNAL_RING_TARGETS = `${OTHER_COMPUTE_TARGET_ID},\n  ${COMPUTE_TARGET_ID}  `;

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution.ring).toBe(DesktopReleaseRing.Internal);
  });

  it("matches an allow-list entry that differs from the request only in case", async () => {
    mocks.env.DESKTOP_INTERNAL_RING_TARGETS = COMPUTE_TARGET_ID.toUpperCase();

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution.ring).toBe(DesktopReleaseRing.Internal);
  });

  it("leaves a target that is not on a populated allow-list on the general ring", async () => {
    mocks.findUnique.mockResolvedValue({
      organizationId: CUSTOMER_ORGANIZATION_ID,
    });
    mocks.env.DESKTOP_INTERNAL_RING_TARGETS = OTHER_COMPUTE_TARGET_ID;

    const resolution = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(resolution.ring).toBe(DesktopReleaseRing.General);
  });

  it("reads no row for a second poll of an unknown id inside the TTL", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await desktopUpdaterRingService.resolveRing(attributedRequest());
    const second = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(second.ring).toBe(DesktopReleaseRing.General);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("negatively caches per id, so one unknown id cannot hide another", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await desktopUpdaterRingService.resolveRing(attributedRequest());
    await desktopUpdaterRingService.resolveRing(
      attributedRequest(OTHER_COMPUTE_TARGET_ID)
    );

    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  /**
   * The positive sibling of the no-second-read case above: without it, a cache
   * that never expired — pinning a target registered a moment later to the general
   * ring forever — would pass every assertion here.
   */
  it("reads again once the negative-cache TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.findUnique.mockResolvedValue({
      organizationId: INTERNAL_ORGANIZATION_ID,
    });
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;

    await desktopUpdaterRingService.resolveRing(attributedRequest());
    vi.setSystemTime(new Date("2026-09-08T00:05:01.000Z"));
    const afterTtl = await desktopUpdaterRingService.resolveRing(
      attributedRequest()
    );

    expect(afterTtl.ring).toBe(DesktopReleaseRing.Internal);
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  /**
   * The size cap, not the TTL. Deleting the eviction loop leaves every other case
   * in this file green, because none of them puts more than two ids in the map —
   * and that cap is the only bound on a map whose keys all come from an
   * unauthenticated request, so a burst inside one TTL window is exactly what it
   * exists to stop.
   */
  it("evicts the oldest unknown id once the size cap is exceeded", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const overflowIds = Array.from(
      { length: UnknownComputeTargetMaxEntries + 1 },
      (_, index) => syntheticComputeTargetId(index)
    );
    for (const id of overflowIds) {
      await desktopUpdaterRingService.resolveRing(attributedRequest(id));
    }
    const readsBeforeReResolve = mocks.findUnique.mock.calls.length;

    await desktopUpdaterRingService.resolveRing(
      attributedRequest(overflowIds[0] as string)
    );

    expect(readsBeforeReResolve).toBe(UnknownComputeTargetMaxEntries + 1);
    expect(mocks.findUnique).toHaveBeenCalledTimes(readsBeforeReResolve + 1);
  });

  /**
   * whitlockk, #6867: the cache key, not the lookup. `z.uuid()` accepts either
   * casing and Postgres compares `uuid` case-insensitively, so the raw header
   * value keys nothing stable — an unauthenticated caller alternating the case
   * of ONE unknown id would defeat the negative cache and buy an indexed read
   * on every poll, which is the database cost this cache exists to dedupe on
   * the one route with no session behind it.
   *
   * Both halves are pinned: the second poll reads no row, AND the row the first
   * one did read was addressed by the normalized id. Asserting only the read
   * count would stay green on a build that keyed the cache on the raw value and
   * happened to be handed the same casing twice.
   */
  it("caches an unknown id by its normalized form, so re-casing it reads no row", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const first = await desktopUpdaterRingService.resolveRing(
      attributedRequest(COMPUTE_TARGET_ID)
    );
    const reCased = await desktopUpdaterRingService.resolveRing(
      attributedRequest(COMPUTE_TARGET_ID.toUpperCase())
    );

    expect(first.ring).toBe(DesktopReleaseRing.General);
    expect(reCased.ring).toBe(DesktopReleaseRing.General);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: COMPUTE_TARGET_ID },
      select: { organizationId: true },
    });
  });

  it("reads one indexed row selecting only the organisation", async () => {
    mocks.findUnique.mockResolvedValue({
      organizationId: CUSTOMER_ORGANIZATION_ID,
    });

    await desktopUpdaterRingService.resolveRing(attributedRequest());

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: COMPUTE_TARGET_ID },
      select: { organizationId: true },
    });
  });
});
