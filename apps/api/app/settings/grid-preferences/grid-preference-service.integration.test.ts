import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GridPreferenceErrorCode,
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceResetStatus,
  GridPreferenceScopeKey,
} from "@repo/api/src/types/grid-preferences";
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../../../__tests__/utils/db-helpers";
import { gridPreferenceService } from "./grid-preference-service";

describe("gridPreferenceService integration", () => {
  it("scopes reads, writes, and reset by both organization and user", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const otherUser = await createTestUser(organizationId);
      const selector = {
        organizationId,
        userId: user.id,
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
      };
      const otherUserSelector = { ...selector, userId: otherUser.id };
      const otherOrganizationSelector = {
        ...selector,
        organizationId: otherOrganizationId,
      };

      await gridPreferenceService.upsertPreference({
        ...selector,
        value: { columnOrder: ["name"] },
      });
      await gridPreferenceService.upsertPreference({
        ...otherUserSelector,
        value: { columnOrder: ["status"] },
      });
      // The separate FKs allow an inconsistent row. It proves the service's org
      // predicate still protects a caller if one such row reaches persistence.
      await withDb((db) =>
        db.gridPreference.create({
          data: {
            ...otherOrganizationSelector,
            value: { columnOrder: ["owner"] },
          },
        })
      );

      await expect(
        gridPreferenceService.listPreferences({
          organizationId,
          userId: user.id,
        })
      ).resolves.toMatchObject([{ value: { columnOrder: ["name"] } }]);
      await expect(
        gridPreferenceService.getPreference(selector)
      ).resolves.toMatchObject({
        value: { columnOrder: ["name"] },
      });

      const updated = await gridPreferenceService.upsertPreference({
        ...selector,
        expectedRevision: 1,
        value: { columnOrder: ["cost"] },
      });
      expect(updated.ok).toBe(true);
      const reset = await gridPreferenceService.resetPreference({
        ...selector,
      });
      expect(reset.ok).toBe(true);
      await expect(
        gridPreferenceService.getPreference(selector)
      ).resolves.toBeNull();
      await expect(
        gridPreferenceService.listPreferences({
          organizationId,
          userId: user.id,
        })
      ).resolves.toEqual([]);
      await expect(
        gridPreferenceService.getPreference(otherUserSelector)
      ).resolves.toMatchObject({
        value: { columnOrder: ["status"] },
      });
      await expect(
        gridPreferenceService.getPreference(otherOrganizationSelector)
      ).resolves.toMatchObject({
        value: { columnOrder: ["owner"] },
      });
    });
  });

  it("keeps selector revisions monotonic across reset and recreation", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const selector = {
        organizationId,
        userId: user.id,
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
      };

      const created = await gridPreferenceService.upsertPreference({
        ...selector,
        value: { columns: ["name"] },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error("expected initial grid preference create to succeed");
      }
      expect(created.value.revision).toBe(1);

      const reset = await gridPreferenceService.resetPreference({
        ...selector,
        expectedRevision: 1,
      });
      expect(reset).toEqual({
        ok: true,
        value: {
          status: GridPreferenceResetStatus.Deleted,
          selector: {
            gridKey: GridPreferenceGridKey.Sessions,
            preferenceKind: GridPreferenceKind.ViewState,
            scopeKey: GridPreferenceScopeKey.Default,
          },
          previousRevision: 1,
          contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
        },
      });
      await expect(
        gridPreferenceService.getPreference(selector)
      ).resolves.toBeNull();

      const staleAfterReset = await gridPreferenceService.upsertPreference({
        ...selector,
        value: { columns: ["stale"] },
        expectedRevision: 1,
      });
      expect(staleAfterReset).toEqual({
        ok: false,
        error: {
          status: Status.Conflict,
          conflict: {
            code: GridPreferenceErrorCode.StaleRevision,
            selector: {
              gridKey: GridPreferenceGridKey.Sessions,
              preferenceKind: GridPreferenceKind.ViewState,
              scopeKey: GridPreferenceScopeKey.Default,
            },
            expectedRevision: 1,
            contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
          },
        },
      });

      const recreated = await gridPreferenceService.upsertPreference({
        ...selector,
        value: { columns: ["status"] },
      });
      expect(recreated.ok).toBe(true);
      if (!recreated.ok) {
        throw new Error("expected grid preference recreate to succeed");
      }
      expect(recreated.value.revision).toBe(3);

      const staleAfterRecreate = await gridPreferenceService.upsertPreference({
        ...selector,
        value: { columns: ["still-stale"] },
        expectedRevision: 1,
      });
      expect(staleAfterRecreate.ok).toBe(false);
      if (staleAfterRecreate.ok) {
        throw new Error("expected stale grid preference write to conflict");
      }
      expect(staleAfterRecreate.error.conflict.currentRevision).toBe(3);
    });
  });
});
