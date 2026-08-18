import { describe, expect, it } from "vitest";
import {
  blockingCapabilityCount,
  Convertibility,
  carriedFieldCount,
  sourceComponents,
  supportedCount,
  targetHarnessFor,
  unsupportedCount,
} from "./mock";

const byId = (id: string) => {
  const source = sourceComponents.find((s) => s.id === id);
  if (!source) {
    throw new Error(`fixture ${id} missing`);
  }
  return source;
};

describe("targetHarnessFor", () => {
  it("always targets the harness the source was not authored for", () => {
    for (const source of sourceComponents) {
      expect(targetHarnessFor(source)).not.toBe(source.sourceHarness);
    }
  });
});

describe("field counts", () => {
  it("carried is every field that is not dropped", () => {
    const partial = byId("release-captain-agent");
    expect(carriedFieldCount(partial)).toBe(
      partial.mappings.length - unsupportedCount(partial)
    );
    // The clean convert drops nothing, so every field is carried.
    const clean = byId("changelog-command");
    expect(carriedFieldCount(clean)).toBe(supportedCount(clean));
    expect(unsupportedCount(clean)).toBe(0);
  });
});

describe("blockingCapabilityCount", () => {
  it("counts only the root blocker, not fields that depend on it", () => {
    const blocked = byId("pre-commit-guard-hook");
    expect(blocked.convertibility).toBe(Convertibility.Blocked);
    // Two fields are unsupported, but only PreToolUse is the actual blocker;
    // Tool matcher only drops because it depends on that trigger.
    expect(unsupportedCount(blocked)).toBe(2);
    expect(blockingCapabilityCount(blocked)).toBe(1);
  });

  it("is zero when nothing carries the blocking flag", () => {
    expect(blockingCapabilityCount(byId("changelog-command"))).toBe(0);
  });
});
