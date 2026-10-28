import { describe, expect, it } from "vitest";
import {
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceScopeKey,
  isSupportedGridPreferenceSelector,
  projectGridPreferenceScopeKey,
} from "./grid-preferences.ts";

describe("grid preference selector support", () => {
  it("accepts default scope for every declared grid", () => {
    for (const gridKey of Object.values(GridPreferenceGridKey)) {
      expect(
        isSupportedGridPreferenceSelector({
          gridKey,
          preferenceKind: GridPreferenceKind.ViewState,
          scopeKey: GridPreferenceScopeKey.Default,
        })
      ).toBe(true);
    }
  });

  it("reserves approved scope for Branches", () => {
    expect(
      isSupportedGridPreferenceSelector({
        gridKey: GridPreferenceGridKey.Branches,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Approved,
      })
    ).toBe(true);
    expect(
      isSupportedGridPreferenceSelector({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Approved,
      })
    ).toBe(false);
  });

  it("reserves project scopes for Project Artifacts", () => {
    const scopeKey = projectGridPreferenceScopeKey("project-one");

    expect(
      isSupportedGridPreferenceSelector({
        gridKey: GridPreferenceGridKey.ProjectArtifacts,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey,
      })
    ).toBe(true);
    expect(
      isSupportedGridPreferenceSelector({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey,
      })
    ).toBe(false);
  });
});
