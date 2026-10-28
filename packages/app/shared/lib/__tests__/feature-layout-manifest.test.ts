import { describe, expect, it } from "vitest";
import {
  allFeatureLocations,
  FEATURE_IDS,
  FEATURE_LAYOUT_MANIFEST,
  FeatureId,
  FeatureLayer,
  FeatureShells,
  featureLocations,
  featuresOwningPath,
} from "../feature-layout-manifest";

const REPO_RELATIVE_POSIX = /^(apps|packages)\/[^\\]+$/;

describe("feature layout manifest", () => {
  it("keys every entry by its own id", () => {
    for (const id of FEATURE_IDS) {
      expect(FEATURE_LAYOUT_MANIFEST[id].id).toBe(id);
    }
  });

  it("gives every web-and-desktop feature a desktop renderer and a desktop main location", () => {
    for (const id of FEATURE_IDS) {
      const entry = FEATURE_LAYOUT_MANIFEST[id];
      if (entry.shells !== FeatureShells.WebAndDesktop) {
        continue;
      }
      expect(featureLocations(id, FeatureLayer.DesktopRenderer)).not.toEqual(
        []
      );
      expect(featureLocations(id, FeatureLayer.DesktopMain)).not.toEqual([]);
    }
  });

  it("declares locations as repo-relative POSIX prefixes and names at least one file prefix", () => {
    for (const id of FEATURE_IDS) {
      expect(FEATURE_LAYOUT_MANIFEST[id].filePrefixes).not.toEqual([]);
      for (const location of allFeatureLocations(id)) {
        expect(location).toMatch(REPO_RELATIVE_POSIX);
      }
    }
  });

  it("resolves a path to every feature that declares it", () => {
    expect(featuresOwningPath("packages/app/agents/components/x.tsx")).toEqual([
      FeatureId.Sessions,
      FeatureId.Agents,
    ]);
    expect(
      featuresOwningPath("packages/app/packs/components/pack-detail-view.tsx")
    ).toEqual([FeatureId.Packs]);
    expect(featuresOwningPath("packages/design-system/button.tsx")).toEqual([]);
  });
});
