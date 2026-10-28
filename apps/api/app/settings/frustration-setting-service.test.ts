import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  // ISS-7142 moved the settings write onto `withDb.tx`, so the row-count guard's
  // throw rolls the statement back rather than reporting one that already
  // committed. Only the transport moved; the statement assertions are unchanged.
  withDbTx: vi.fn(),
}));

// Minimal Prisma.sql tag stub: records the static SQL text and the interpolated
// values so the atomic-write test can assert the jsonb_set statement and its
// parameters without a live database.
vi.mock("@repo/database", () => ({
  withDb: Object.assign(mocks.withDb, { tx: mocks.withDbTx }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      text: strings.join("?"),
      values,
    }),
  },
}));

import type { RenderedSqlStatement } from "@/__tests__/support/organizations/render-settings-sql";
import {
  renderedWhereClause,
  renderSql,
} from "@/__tests__/support/organizations/render-settings-sql";
import {
  organizationSettingsWriteStatements,
  SETTINGS_WRITE_STATEMENT_COUNT,
} from "@/__tests__/support/organizations/settings-write-statements";
import { organizationSettingsNotPersistedMessage } from "@/lib/organization-settings-write";
import {
  FRUSTRATION_SETTING_WRITE_SUBJECT,
  frustrationSettingService,
} from "./frustration-setting-service";

/**
 * FEA-4022: the org frustration opt-in gate. `withDb` runs its callback against
 * a fake Prisma whose `organization` delegate returns the seeded settings JSON
 * and records the update payload, so we assert both the default-off read and the
 * merge-preserving write.
 */
function installDb(db: Record<string, unknown>) {
  const run = (cb: (client: unknown) => unknown) => Promise.resolve(cb(db));
  mocks.withDb.mockImplementation(run);
  mocks.withDbTx.mockImplementation(run);
}

describe("frustrationSettingService", () => {
  beforeEach(() => {
    mocks.withDb.mockReset();
    mocks.withDbTx.mockReset();
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

  /**
   * ISS-7142: `$executeRaw` is reachable ONLY through `withDb.tx`. The `> 1`
   * branch of the shared guard is a refusal rather than a post-commit report
   * solely because it throws inside a transaction that rolls back, so wiring
   * both transports to one double would leave that property untested.
   */
  function installAtomicWriteDb(rowsUpdated = 1) {
    const executeRaw = vi.fn(
      (_sql: RenderedSqlStatement): Promise<number> =>
        Promise.resolve(rowsUpdated)
    );
    const findUnique = vi.fn(() =>
      Promise.resolve({ settings: { computeMode: "LOOPS" } })
    );
    const update = vi.fn(() => Promise.resolve({}));
    // Both present so a regression back to read-modify-write would be
    // observable: the atomic path must NOT read the settings blob first, nor
    // issue a whole-blob `update` afterwards.
    const organization = { findUnique, update };
    mocks.withDbTx.mockImplementation((cb: (client: unknown) => unknown) =>
      Promise.resolve(cb({ $executeRaw: executeRaw, organization }))
    );
    mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) =>
      Promise.resolve(cb({ organization }))
    );
    return { executeRaw, findUnique, update };
  }

  it("runs the settings write inside a transaction, so the row-count guard can roll back", async () => {
    const { executeRaw } = installAtomicWriteDb();

    await frustrationSettingService.setFrustrationEnabled("org-1", true);

    expect(mocks.withDbTx).toHaveBeenCalledOnce();
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledTimes(SETTINGS_WRITE_STATEMENT_COUNT);
  });

  it("re-stamps updated_at in a second statement, from behind the row lock", async () => {
    const { executeRaw } = installAtomicWriteDb();

    await frustrationSettingService.setFrustrationEnabled("org-1", true);

    // ISS-7157: the second statement is the post-lock `updated_at` re-stamp.
    // Asserting its shape, not just the count, is what makes the count mean
    // something — a stray extra settings write would satisfy a bare `2`.
    const { settings, stamp } = organizationSettingsWriteStatements(
      executeRaw.mock.calls
    );
    expect(settings.text).toContain("jsonb_set");
    expect(renderSql(stamp)).toContain('"updated_at" = GREATEST("updated_at"');
    expect(stamp.values[0]).toBeInstanceOf(Date);
    expect(renderedWhereClause(stamp)).toBe('"id" = "org-1"::uuid');
  });

  it("patches only its own key atomically via jsonb_set (no read-modify-write of the whole blob)", async () => {
    const { executeRaw, findUnique, update } = installAtomicWriteDb();

    await frustrationSettingService.setFrustrationEnabled("org-1", true);

    // Single atomic statement — no blob read before it and no blob write after
    // it, so there is no read-then-write window a concurrent writer to a
    // DIFFERENT settings key can be lost in.
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const stmt = executeRaw.mock.calls[0][0];
    // jsonb_set patches the single key in place rather than replacing the blob.
    expect(stmt.text).toContain("jsonb_set");
    expect(stmt.text).toContain('UPDATE "organizations"');
    // ISS-7147. The patch base is the LIVE column. Rewriting it as a bare
    // `'{}'::jsonb` would wipe every sibling key while the rest of this block
    // stayed green.
    expect(stmt.text).toContain('COALESCE("settings"');
    // The setting key and the boolean value are bound parameters.
    expect(stmt.values).toContain(SESSION_FRUSTRATION_SETTING_KEY);
    expect(stmt.values).toContain(true);
    // ISS-7122's shape, which this suite alone was missing: the predicate text
    // AND the bound id asserted together, as the WHOLE clause. `values` merely
    // CONTAINING the org id stays green under every widening of the predicate,
    // including one that keeps the equality and appends `OR TRUE`.
    expect(renderedWhereClause(stmt)).toBe('"id" = "org-1"::uuid');
  });

  it("binds the caller's organization id rather than a fixed one", async () => {
    const { executeRaw } = installAtomicWriteDb();

    await frustrationSettingService.setFrustrationEnabled("org-2", false);

    // ISS-7147. A second, DIFFERENT org id: pinning only `org-1` above stays
    // green against a predicate that ignored its argument and matched one
    // hardcoded row. The `false` also proves the opt-OUT write is scoped, not
    // just the opt-in.
    expect(renderedWhereClause(executeRaw.mock.calls[0][0])).toBe(
      '"id" = "org-2"::uuid'
    );
    expect(executeRaw.mock.calls[0][0].values).toContain(false);
  });

  it("reports failure rather than success when no organization row matched", async () => {
    // ISS-7142: this path is where the asymmetry was. Its three sibling
    // `Organization.settings` writers already refused a zero-row write; this one
    // discarded the count, so a toggle against a deleted organization resolved
    // as if it had persisted.
    const { executeRaw } = installAtomicWriteDb(0);

    await expect(
      frustrationSettingService.setFrustrationEnabled("org-1", true)
    ).rejects.toThrow(
      organizationSettingsNotPersistedMessage(
        FRUSTRATION_SETTING_WRITE_SUBJECT,
        "org-1"
      )
    );
    // Exactly ONE call: the row-count guard throws between the settings write
    // and the ISS-7157 re-stamp, so a refused write leaves no stamp behind.
    expect(executeRaw).toHaveBeenCalledOnce();
  });
});
