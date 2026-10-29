import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (client: unknown) => unknown) =>
    fn({ featureFlagSnapshot: { findUnique: db.findUnique } }),
}));

import {
  clearFeatureFlagSnapshotCache,
  readActiveFeatureFlagSnapshot,
} from "../feature-flag-snapshot";

const ROW = {
  id: "current",
  distinctId: "user_2abc",
  orgId: "org_2xyz",
  takenAt: new Date("2026-10-06T15:00:00.000Z"),
  flags: { "session-trace-tab": true, "pensero-integration": "variant-a" },
  updatedAt: new Date("2026-10-06T15:00:01.000Z"),
};
const NOW = 1_000_000;

beforeEach(() => {
  clearFeatureFlagSnapshotCache();
  vi.stubEnv("PGSCHEMA", undefined);
  db.findUnique.mockResolvedValue(ROW);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function asPreview() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feat/iss-12048-vibe");
}

/**
 * ISS-12048: the snapshot pins flags only on a preview schema. Production and
 * stage resolve no schema (`public`), so they must never even read the table.
 */
describe("readActiveFeatureFlagSnapshot", () => {
  it("never reads the table outside a preview schema", async () => {
    vi.stubEnv("VERCEL_ENV", "production");

    await expect(readActiveFeatureFlagSnapshot(NOW)).resolves.toBeNull();
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("pins the stored snapshot on a preview schema, and caches it", async () => {
    asPreview();

    const snapshot = await readActiveFeatureFlagSnapshot(NOW);
    await readActiveFeatureFlagSnapshot(NOW + 1000);

    expect(snapshot).toEqual({
      takenAt: ROW.takenAt.toISOString(),
      distinctId: ROW.distinctId,
      orgId: ROW.orgId,
      flags: ROW.flags,
    });
    expect(db.findUnique).toHaveBeenCalledTimes(1);
    expect(db.findUnique).toHaveBeenCalledWith({ where: { id: "current" } });
  });

  it("pins nothing for a preview schema without a snapshot", async () => {
    asPreview();
    db.findUnique.mockResolvedValue(null);

    await expect(readActiveFeatureFlagSnapshot(NOW)).resolves.toBeNull();
  });

  it("pins nothing for a malformed row or a failed read", async () => {
    asPreview();
    db.findUnique.mockResolvedValue({ ...ROW, flags: { "a-flag": 3 } });
    await expect(readActiveFeatureFlagSnapshot(NOW)).resolves.toBeNull();

    clearFeatureFlagSnapshotCache();
    db.findUnique.mockRejectedValue(new Error("connection refused"));
    await expect(readActiveFeatureFlagSnapshot(NOW)).resolves.toBeNull();
  });
});
