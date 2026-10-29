import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import { describe, expect, it } from "vitest";
import { ArtifactFlag } from "../../../lib/artifact-flags";
import {
  SESSION_TRACE_TAB_FEATURE_FLAG_KEY,
  SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY,
} from "../../../lib/feature-flags";
import {
  createDevToolsRegistry,
  type DevToolsSection,
} from "../dev-tools-registry";
import { DEV_TOOLS_REGISTRY } from "../dev-tools-sections";
import {
  collectFeatureFlagKeys,
  FEATURE_FLAGS_DEV_TOOLS_SECTION,
} from "../feature-flags-dev-tools-section";

const FIRST_SECTION: DevToolsSection = {
  id: "first",
  title: "First",
  storageKey: "test:first",
  controls: [],
};
const SECOND_SECTION: DevToolsSection = {
  id: "second",
  title: "Second",
  storageKey: "test:second",
  controls: [],
};

describe("createDevToolsRegistry", () => {
  it("keeps sections in registration order, keyed by id", () => {
    const registry = createDevToolsRegistry([SECOND_SECTION, FIRST_SECTION]);

    expect([...registry.keys()]).toEqual([SECOND_SECTION.id, FIRST_SECTION.id]);
    expect(registry.get(FIRST_SECTION.id)).toBe(FIRST_SECTION);
  });

  it("refuses a repeated section id", () => {
    expect(() =>
      createDevToolsRegistry([
        FIRST_SECTION,
        { ...SECOND_SECTION, id: FIRST_SECTION.id },
      ])
    ).toThrow(FIRST_SECTION.id);
  });

  it("refuses two sections sharing a storage key", () => {
    expect(() =>
      createDevToolsRegistry([
        FIRST_SECTION,
        { ...SECOND_SECTION, storageKey: FIRST_SECTION.storageKey },
      ])
    ).toThrow(FIRST_SECTION.storageKey);
  });
});

describe("collectFeatureFlagKeys", () => {
  it("takes only overridable *_FEATURE_FLAG_KEY string exports, de-duplicated and sorted, plus artifact keys", () => {
    const keys = collectFeatureFlagKeys({
      ZETA_FEATURE_FLAG_KEY: "zeta-flag",
      ALPHA_FEATURE_FLAG_KEY: "alpha-flag",
      ALPHA_ALIAS_FEATURE_FLAG_KEY: "alpha-flag",
      NOT_A_FLAG: "not-a-flag",
      RESTRICTION_FEATURE_FLAG_KEY: "compute-target-signing",
      OBJECT_FEATURE_FLAG_KEY: { nested: "nested-flag" },
    });

    expect(keys).toEqual(
      ["alpha-flag", "zeta-flag", ...Object.values(ArtifactFlag)].sort((a, b) =>
        a.localeCompare(b)
      )
    );
  });
});

describe("the feature flags section", () => {
  it("lists keys from the canonical registry, each labelled with its key", () => {
    const ids = FEATURE_FLAGS_DEV_TOOLS_SECTION.controls.map(({ id }) => id);

    expect(ids).toContain(SESSION_TRACE_TAB_FEATURE_FLAG_KEY);
    expect(ids).toContain(SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY);
    expect(ids).toContain(ArtifactFlag.Issues);
    expect(new Set(ids).size).toBe(ids.length);
    for (const control of FEATURE_FLAGS_DEV_TOOLS_SECTION.controls) {
      expect(control.label).toBe(control.id);
    }
  });

  it("writes the overrides key the analytics precedence reads, and is registered", () => {
    expect(FEATURE_FLAGS_DEV_TOOLS_SECTION.storageKey).toBe(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY
    );
    expect(DEV_TOOLS_REGISTRY.get(FEATURE_FLAGS_DEV_TOOLS_SECTION.id)).toBe(
      FEATURE_FLAGS_DEV_TOOLS_SECTION
    );
  });
});
