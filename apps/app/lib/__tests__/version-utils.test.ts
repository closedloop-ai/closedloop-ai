import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { describe, expect, test } from "vitest";
import {
  compareVersions,
  getPluginVersion,
  isUpdateAvailable,
  validatePluginVersion,
} from "../version-utils";

describe("compareVersions", () => {
  test("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("returns -1 when a has lower major version", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  test("returns 1 when a has higher major version", () => {
    expect(compareVersions("3.0.0", "2.0.0")).toBe(1);
  });

  test("returns -1 when a has lower minor version", () => {
    expect(compareVersions("1.2.0", "1.3.0")).toBe(-1);
  });

  test("returns 1 when a has higher minor version", () => {
    expect(compareVersions("1.4.0", "1.3.0")).toBe(1);
  });

  test("returns -1 when a has lower patch version", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  });

  test("returns 1 when a has higher patch version", () => {
    expect(compareVersions("1.2.5", "1.2.4")).toBe(1);
  });

  test("handles versions with pre-release suffixes", () => {
    expect(compareVersions("1.2.3-alpha", "1.2.3")).toBe(0);
  });

  test("compares major before minor and patch", () => {
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  test("returns null for invalid version strings", () => {
    expect(compareVersions("invalid", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "invalid")).toBeNull();
    expect(compareVersions("invalid", "invalid")).toBeNull();
  });

  test("returns null when first argument is not a version", () => {
    expect(compareVersions("not-a-version", "1.0.0")).toBeNull();
  });

  test("returns null when second argument is not a version", () => {
    expect(compareVersions("1.0.0", "not-a-version")).toBeNull();
  });

  test("handles multi-digit version components", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
  });
});

describe("isUpdateAvailable", () => {
  test("returns false when currentVersion is undefined", () => {
    expect(isUpdateAvailable(undefined, "1.0.0")).toBe(false);
  });

  test("returns false when versions are equal", () => {
    expect(isUpdateAvailable("1.0.0", "1.0.0")).toBe(false);
  });

  test("returns true when latest is strictly newer", () => {
    expect(isUpdateAvailable("1.0.0", "1.0.1")).toBe(true);
    expect(isUpdateAvailable("1.0.0", "1.1.0")).toBe(true);
    expect(isUpdateAvailable("1.0.0", "2.0.0")).toBe(true);
  });

  test("returns false when current is newer than latest", () => {
    expect(isUpdateAvailable("2.0.0", "1.0.0")).toBe(false);
  });

  test("returns false when currentVersion is empty string", () => {
    expect(isUpdateAvailable("", "1.0.0")).toBe(false);
  });

  test("returns false when currentVersion is not a valid version string", () => {
    expect(isUpdateAvailable("not-a-version", "1.0.0")).toBe(false);
  });
});

describe("getPluginVersion", () => {
  function makeTarget(capabilities: JsonObject): ComputeTarget {
    return {
      id: "test-id",
      organizationId: "org-id",
      userId: "user-id",
      machineName: "machine",
      platform: "linux",
      capabilities,
      supportedOperations: [],
      lastSeenAt: new Date(),
      isOnline: true,
      isSharedWithOrg: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  test("returns pluginVersion string from capabilities", () => {
    const target = makeTarget({ pluginVersion: "1.2.3" });
    expect(getPluginVersion(target)).toBe("1.2.3");
  });

  test("returns undefined when pluginVersion is not present", () => {
    const target = makeTarget({});
    expect(getPluginVersion(target)).toBeUndefined();
  });

  test("returns undefined when pluginVersion is not a string", () => {
    const target = makeTarget({ pluginVersion: 123 });
    expect(getPluginVersion(target)).toBeUndefined();
  });

  test("returns undefined when pluginVersion is null", () => {
    const target = makeTarget({ pluginVersion: null });
    expect(getPluginVersion(target)).toBeUndefined();
  });

  test("returns undefined when pluginVersion is an empty string", () => {
    const target = makeTarget({ pluginVersion: "" });
    expect(getPluginVersion(target)).toBeUndefined();
  });

  test("returns undefined when pluginVersion is a boolean", () => {
    const target = makeTarget({ pluginVersion: true as unknown as JsonValue });
    expect(getPluginVersion(target)).toBeUndefined();
  });
});

describe("validatePluginVersion", () => {
  test("returns undefined for undefined input", () => {
    expect(validatePluginVersion(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(validatePluginVersion("")).toBeUndefined();
  });

  test("returns the version for valid semver strings", () => {
    expect(validatePluginVersion("1.0.0")).toBe("1.0.0");
    expect(validatePluginVersion("1.2.3")).toBe("1.2.3");
    expect(validatePluginVersion("10.20.30")).toBe("10.20.30");
  });

  test("returns undefined for non-semver strings", () => {
    expect(validatePluginVersion("not-a-version")).toBeUndefined();
    expect(validatePluginVersion("v1.2.3")).toBeUndefined();
    expect(validatePluginVersion("1.2")).toBeUndefined();
  });

  test("truncates versions longer than 50 characters", () => {
    const longVersion = `1.2.3-${"a".repeat(60)}`;
    const result = validatePluginVersion(longVersion);
    expect(result).toBeDefined();
    expect(result!.length).toBe(50);
  });

  test("does not truncate versions at exactly 50 characters", () => {
    const version = `1.2.3-${"a".repeat(44)}`; // total 50 chars
    expect(version.length).toBe(50);
    const result = validatePluginVersion(version);
    expect(result).toBe(version);
  });

  test("accepts versions with pre-release suffixes", () => {
    expect(validatePluginVersion("1.0.0-alpha")).toBe("1.0.0-alpha");
    expect(validatePluginVersion("1.0.0.beta")).toBe("1.0.0.beta");
  });
});
