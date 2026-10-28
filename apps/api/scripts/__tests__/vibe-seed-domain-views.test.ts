/**
 * ISS-12017: the domain stages' fixed payloads against the contracts the API
 * enforces on them, and the stage slot's wiring. The saved views must pass the
 * PUT /settings/grid-preferences validator, and the slot must claim exactly the
 * models this work package fills.
 */
import {
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceScopeKey,
  isSupportedGridPreferenceSelector,
} from "@repo/api/src/types/grid-preferences";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPreference: vi.fn(),
  upsertPreference: vi.fn(),
}));

vi.mock(
  "@/app/settings/grid-preferences/grid-preference-service",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/app/settings/grid-preferences/grid-preference-service")
      >();
    return {
      ...actual,
      gridPreferenceService: {
        ...actual.gridPreferenceService,
        getPreference: mocks.getPreference,
        upsertPreference: mocks.upsertPreference,
      },
    };
  }
);

import { gridPreferenceUpsertRequestValidator } from "@/app/settings/grid-preferences/validators";
import {
  SEED_GRID_PREFERENCES,
  seedGridPreferences,
} from "../vibe-seed/domain/grid-preferences";
import type { VibeSeedContext } from "../vibe-seed/stage";
import { STAGES as DELIVERY_STAGES } from "../vibe-seed/stages/delivery";
import { STAGES } from "../vibe-seed/stages/domain";

describe("SEED_GRID_PREFERENCES", () => {
  it("passes the grid preference PUT validator unchanged", () => {
    for (const request of SEED_GRID_PREFERENCES) {
      const parsed = gridPreferenceUpsertRequestValidator.safeParse(request);
      expect(parsed.success, `${request.gridKey}/${request.scopeKey}`).toBe(
        true
      );
      expect(parsed.data?.value).toStrictEqual(request.value);
      expect(isSupportedGridPreferenceSelector(request)).toBe(true);
    }
  });

  it("stores one view per selector, covering every grid", () => {
    const selectors = SEED_GRID_PREFERENCES.map(
      (request) =>
        `${request.gridKey}/${request.preferenceKind}/${request.scopeKey}`
    );
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(
      new Set(SEED_GRID_PREFERENCES.map((request) => request.gridKey))
    ).toStrictEqual(new Set(Object.values(GridPreferenceGridKey)));
  });
});

describe("seedGridPreferences", () => {
  beforeEach(() => {
    mocks.upsertPreference.mockResolvedValue({ ok: true, value: {} });
  });

  it("writes only the views the user has not stored yet", async () => {
    mocks.getPreference.mockImplementation((selector) =>
      Promise.resolve(
        selector.gridKey === GridPreferenceGridKey.Sessions ? {} : null
      )
    );
    const context = {
      organizationId: "org-1",
      userId: "user-1",
      log: vi.fn(),
    } as unknown as VibeSeedContext;

    await seedGridPreferences(context);

    const written = mocks.upsertPreference.mock.calls.map(
      ([input]) => `${input.gridKey}/${input.scopeKey}`
    );
    expect(written).toStrictEqual([
      `${GridPreferenceGridKey.Branches}/${GridPreferenceScopeKey.Default}`,
      `${GridPreferenceGridKey.Branches}/${GridPreferenceScopeKey.Approved}`,
      `${GridPreferenceGridKey.Agents}/${GridPreferenceScopeKey.Default}`,
      `${GridPreferenceGridKey.ProjectArtifacts}/${GridPreferenceScopeKey.Default}`,
    ]);
    expect(mocks.upsertPreference.mock.calls[0][0]).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      preferenceKind: GridPreferenceKind.ViewState,
    });
  });
});

describe("domain STAGES", () => {
  it("claims exactly the models the domain work package fills", () => {
    const domainWork = [...STAGES, ...DELIVERY_STAGES];
    expect(new Set(domainWork.flatMap((stage) => stage.models))).toStrictEqual(
      new Set([
        "ArtifactActivityEvent",
        "CatalogItemVersion",
        "CustomFieldValueReference",
        "DeliveryPoint",
        "Distribution",
        "DistributionTargetStatus",
        "DistributionTargetingEntry",
        "FavoriteArtifact",
        "FavoriteProject",
        "GridPreference",
        "Tag",
        "TagArtifact",
        "TagProject",
      ])
    );
  });

  it("wires the grid-preferences stage to its writer", async () => {
    mocks.getPreference.mockResolvedValue(null);
    mocks.upsertPreference.mockResolvedValue({ ok: true, value: {} });
    const stage = STAGES.find((entry) => entry.name === "grid-preferences");
    await stage?.run({
      organizationId: "org-1",
      userId: "user-1",
      log: vi.fn(),
    } as unknown as VibeSeedContext);
    expect(mocks.upsertPreference).toHaveBeenCalledTimes(
      SEED_GRID_PREFERENCES.length
    );
  });
});
