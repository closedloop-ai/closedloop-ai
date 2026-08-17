import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

// Minimal Prisma.sql tag stub: records the static SQL text and the interpolated
// values so the atomic-write test can assert the jsonb_set statement and its
// parameters without a live database.
vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: strings.join("?"),
      values,
    }),
  },
}));

import { frustrationSettingService } from "./frustration-setting-service";

/**
 * FEA-4022: the org frustration opt-in gate. `withDb` runs its callback against
 * a fake Prisma whose `organization` delegate returns the seeded settings JSON
 * and records the update payload, so we assert both the default-off read and the
 * merge-preserving write.
 */
function installDb(db: Record<string, unknown>) {
  mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) =>
    Promise.resolve(cb(db))
  );
}

describe("frustrationSettingService", () => {
  beforeEach(() => {
    mocks.withDb.mockReset();
  });

  it("defaults to disabled when the org has no settings", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() => Promise.resolve({ settings: null })),
      },
    });

    const enabled =
      await frustrationSettingService.isFrustrationEnabled("org-1");

    expect(enabled).toBe(false);
  });

  it("defaults to disabled when the key is absent or not boolean-true", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() =>
          Promise.resolve({
            settings: {
              computeMode: "LOOPS",
              [SESSION_FRUSTRATION_SETTING_KEY]: "true", // string, not boolean
            },
          })
        ),
      },
    });

    const enabled =
      await frustrationSettingService.isFrustrationEnabled("org-1");

    // Only an explicit boolean `true` opts in — a truthy string does not.
    expect(enabled).toBe(false);
  });

  it("returns true only when the setting is boolean true", async () => {
    installDb({
      organization: {
        findUnique: vi.fn(() =>
          Promise.resolve({
            settings: { [SESSION_FRUSTRATION_SETTING_KEY]: true },
          })
        ),
      },
    });

    const enabled =
      await frustrationSettingService.isFrustrationEnabled("org-1");

    expect(enabled).toBe(true);
  });

  it("patches only its own key atomically via jsonb_set (no read-modify-write of the whole blob)", async () => {
    const executeRaw = vi.fn(
      (_sql: { text: string; values: unknown[] }): Promise<number> =>
        Promise.resolve(1)
    );
    const findUnique = vi.fn(() => Promise.resolve({ settings: {} }));
    installDb({
      $executeRaw: executeRaw,
      // Present so a regression back to read-modify-write would be observable:
      // the atomic path must NOT read the settings blob first.
      organization: { findUnique },
    });

    await frustrationSettingService.setFrustrationEnabled("org-1", true);

    // Single atomic statement — no prior findUnique read of the JSON blob.
    expect(findUnique).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledOnce();
    const stmt = executeRaw.mock.calls[0][0];
    // jsonb_set patches the single key in place rather than replacing the blob.
    expect(stmt.text).toContain("jsonb_set");
    expect(stmt.text).toContain('UPDATE "organizations"');
    // The setting key and the boolean value are bound parameters.
    expect(stmt.values).toContain(SESSION_FRUSTRATION_SETTING_KEY);
    expect(stmt.values).toContain(true);
  });
});
