import type { ComputeMode } from "@repo/api/src/types/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import { computeModeService } from "./compute-mode-service";

/**
 * ISS-4504: org compute-mode read/write over the `Organization.settings` JSON
 * column. `withDb` runs its callback against a fake Prisma whose `organization`
 * delegate returns the seeded settings and records the `findUnique`/`update`
 * calls, so we assert the LOOPS fallback branch, the merge-preserving write, and
 * org-scoping on both the read and the write predicate — without a live DB.
 */
// `ComputeMode` is a bare string union (no runtime const object exists to
// import), so these literals are typed as `ComputeMode` — a typo fails
// typecheck and cannot silently widen the contract.
const GITHUB_ACTIONS_MODE: ComputeMode = "GITHUB_ACTIONS";
const LOOPS_MODE: ComputeMode = "LOOPS";

function installDb(db: Record<string, unknown>) {
  mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) =>
    Promise.resolve(cb(db))
  );
}

describe("computeModeService.getComputeMode", () => {
  beforeEach(() => {
    mocks.withDb.mockReset();
  });

  it("returns the stored valid mode scoped to the requested org", async () => {
    const findUnique = vi.fn(() =>
      Promise.resolve({ settings: { computeMode: GITHUB_ACTIONS_MODE } })
    );
    installDb({ organization: { findUnique } });

    const mode = await computeModeService.getComputeMode("org-1");

    expect(mode).toBe(GITHUB_ACTIONS_MODE);
    // Org-scoping: the read is keyed by the caller's org id, not org-wide.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "org-1" },
      select: { settings: true },
    });
  });

  it("falls back to LOOPS when the org has no settings row", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() => Promise.resolve(null)),
      },
    });

    const mode = await computeModeService.getComputeMode("org-1");

    expect(mode).toBe(LOOPS_MODE);
  });

  it("falls back to LOOPS when settings is null (LOOPS-fallback branch)", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() => Promise.resolve({ settings: null })),
      },
    });

    const mode = await computeModeService.getComputeMode("org-1");

    expect(mode).toBe(LOOPS_MODE);
  });

  it("falls back to LOOPS when the stored mode is not a recognized value", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() =>
          Promise.resolve({ settings: { computeMode: "SOMETHING_ELSE" } })
        ),
      },
    });

    const mode = await computeModeService.getComputeMode("org-1");

    // An unknown/invalid persisted value must degrade to the safe default, not
    // leak the raw string through the contract.
    expect(mode).toBe(LOOPS_MODE);
  });

  it("falls back to LOOPS when the stored mode is a non-string type", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() =>
          Promise.resolve({ settings: { computeMode: 42 } })
        ),
      },
    });

    const mode = await computeModeService.getComputeMode("org-1");

    expect(mode).toBe(LOOPS_MODE);
  });

  it("returns LOOPS when it is the explicitly stored mode", async () => {
    // Distinct from the fallback path: prove a stored LOOPS is honored (not only
    // reached because everything defaults to it).
    installDb({
      organization: {
        findUnique: vi.fn(() =>
          Promise.resolve({ settings: { computeMode: LOOPS_MODE } })
        ),
      },
    });

    const mode = await computeModeService.getComputeMode("org-1");

    expect(mode).toBe(LOOPS_MODE);
  });
});

describe("computeModeService.setComputeMode", () => {
  beforeEach(() => {
    mocks.withDb.mockReset();
  });

  it("overwrites a previously configured mode while preserving unrelated keys", async () => {
    // Seed a PRIOR computeMode (not just an unrelated key): if the production
    // spread were reversed to `{ computeMode: mode, ...existing }`, the stale
    // stored mode would win and the toggle would be a silent no-op. That bug is
    // invisible to a fixture whose settings carry no computeMode, so this test
    // pins the new mode overriding the old one.
    const findUnique = vi.fn(() =>
      Promise.resolve({
        settings: { existingKey: "keep-me", computeMode: LOOPS_MODE },
      })
    );
    const update = vi.fn(() => Promise.resolve({}));
    installDb({ organization: { findUnique, update } });

    await computeModeService.setComputeMode("org-1", GITHUB_ACTIONS_MODE);

    // Read is org-scoped.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "org-1" },
      select: { settings: true },
    });
    // Write is org-scoped, preserves the unrelated key (merge, not replace), AND
    // replaces the prior computeMode with the requested one.
    expect(update).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: {
        settings: { existingKey: "keep-me", computeMode: GITHUB_ACTIONS_MODE },
      },
    });
  });

  it("writes computeMode even when the org has no prior settings", async () => {
    const update = vi.fn(() => Promise.resolve({}));
    installDb({
      organization: {
        findUnique: vi.fn(() => Promise.resolve({ settings: null })),
        update,
      },
    });

    await computeModeService.setComputeMode("org-2", LOOPS_MODE);

    expect(update).toHaveBeenCalledWith({
      where: { id: "org-2" },
      data: { settings: { computeMode: LOOPS_MODE } },
    });
  });

  it("rejects an invalid mode without touching the database", async () => {
    const findUnique = vi.fn(() => Promise.resolve({ settings: {} }));
    const update = vi.fn(() => Promise.resolve({}));
    installDb({ organization: { findUnique, update } });

    // Cast an out-of-contract string to ComputeMode to exercise the service's
    // runtime `VALID_MODES` guard — the compile-time union alone would reject it.
    const invalidMode = "INVALID_MODE" as ComputeMode;
    await expect(
      computeModeService.setComputeMode("org-1", invalidMode)
    ).rejects.toThrow("Invalid compute mode: INVALID_MODE");

    // Guard fires before any read or write — no DB side effects on rejection.
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
