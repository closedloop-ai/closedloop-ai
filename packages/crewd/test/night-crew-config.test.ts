import { describe, expect, it } from "vitest";
import {
  NIGHT_CREW_CONFIG_META_KEY,
  nightCrewConfigSchema,
  readNightCrewConfig,
} from "../src/scheduler/night-crew-config.js";

/**
 * FEA-4143 Slice 2: the night-crew review config carried on `ScheduledTask.meta`.
 * The schema is a version-/process-skew boundary, so it must (a) accept a valid
 * config, (b) reject a fundamentally malformed one, and (c) degrade gracefully —
 * drop unknown extra keys rather than reject the whole config, and default
 * absent optional fields instead of failing.
 */

describe("nightCrewConfigSchema", () => {
  it("accepts a fully-specified config", () => {
    const parsed = nightCrewConfigSchema.safeParse({
      repoDir: "/repos/app",
      characters: ["docs-darwin", "code-cassandra"],
      projectSlug: "night-crew",
      assigneeId: "user-1",
      cascade: ["codex", "claude"],
      slackDestination: { channel: "#reviews" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.repoDir).toBe("/repos/app");
      // The cascade steps normalize bare harness names to `(harness, model?)`.
      expect(parsed.data.cascade).toEqual([
        { harness: "codex" },
        { harness: "claude" },
      ]);
    }
  });

  it("accepts a minimal config (only the load-bearing fields)", () => {
    const parsed = nightCrewConfigSchema.safeParse({
      repoDir: "/repos/app",
      characters: ["docs-darwin"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Absent optionals stay omitted, not coerced to null/"undefined".
      expect(parsed.data.projectSlug).toBeUndefined();
      expect(parsed.data.assigneeId).toBeUndefined();
      expect(parsed.data.cascade).toBeUndefined();
      expect(parsed.data.slackDestination).toBeUndefined();
    }
  });

  it("rejects a config missing the load-bearing repoDir", () => {
    const parsed = nightCrewConfigSchema.safeParse({
      characters: ["docs-darwin"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty character list", () => {
    const parsed = nightCrewConfigSchema.safeParse({
      repoDir: "/repos/app",
      characters: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("dedupes a cascade to one step per harness, keeping the first (first-wins)", () => {
    // A persisted/hand-edited row can carry a duplicate harness; the picker caps
    // one step per harness, so the persisted boundary normalizes the same way.
    const parsed = nightCrewConfigSchema.safeParse({
      repoDir: "/repos/app",
      characters: ["docs-darwin"],
      cascade: ["codex:o3", "claude", "codex:gpt-5", "claude:opus"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // First occurrence of each harness wins; the later dead duplicates drop.
      expect(parsed.data.cascade).toEqual([
        { harness: "codex", model: "o3" },
        { harness: "claude" },
      ]);
    }
  });

  it("drops unknown extra keys rather than rejecting (forward skew)", () => {
    const parsed = nightCrewConfigSchema.safeParse({
      repoDir: "/repos/app",
      characters: ["docs-darwin"],
      futureFieldFromNewerBuild: { anything: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as Record<string, unknown>).futureFieldFromNewerBuild
      ).toBeUndefined();
    }
  });
});

describe("readNightCrewConfig", () => {
  it("reads a valid config off the meta bag", () => {
    const config = readNightCrewConfig({
      [NIGHT_CREW_CONFIG_META_KEY]: {
        repoDir: "/repos/app",
        characters: ["docs-darwin"],
      },
    });
    expect(config).not.toBeNull();
    expect(config?.repoDir).toBe("/repos/app");
  });

  it("returns null when the key is absent (skew-safe: no config on old rows)", () => {
    expect(readNightCrewConfig({})).toBeNull();
    expect(readNightCrewConfig({ other: 1 })).toBeNull();
  });

  it("returns null for a malformed value rather than throwing", () => {
    expect(
      readNightCrewConfig({ [NIGHT_CREW_CONFIG_META_KEY]: { characters: [] } })
    ).toBeNull();
    expect(
      readNightCrewConfig({ [NIGHT_CREW_CONFIG_META_KEY]: "not-an-object" })
    ).toBeNull();
    expect(
      readNightCrewConfig({ [NIGHT_CREW_CONFIG_META_KEY]: null })
    ).toBeNull();
  });
});
