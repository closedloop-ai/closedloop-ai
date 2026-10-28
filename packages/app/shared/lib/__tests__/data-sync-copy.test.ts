import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { describe, expect, it } from "vitest";
import { DATA_SYNC_LEVEL_COPY, findDataSyncLevelCopy } from "../data-sync-copy";

describe("findDataSyncLevelCopy", () => {
  it("returns the canonical copy entry for every DataSyncLevel value", () => {
    for (const level of Object.values(DataSyncLevel)) {
      expect(findDataSyncLevelCopy(level)).toBe(DATA_SYNC_LEVEL_COPY[level]);
    }
  });

  it("throws a descriptive error for an unrecognized level", () => {
    const bogus = "bogus-level" as DataSyncLevel;
    expect(() => findDataSyncLevelCopy(bogus)).toThrow(
      "Unknown data sync level: bogus-level"
    );
  });
});

describe("DATA_SYNC_LEVEL_COPY", () => {
  it("has an entry for every canonical DataSyncLevel value", () => {
    expect(Object.keys(DATA_SYNC_LEVEL_COPY).sort()).toEqual(
      Object.values(DataSyncLevel).sort()
    );
  });

  it("every entry carries the required presentational fields", () => {
    for (const copy of Object.values(DATA_SYNC_LEVEL_COPY)) {
      expect(typeof copy.title).toBe("string");
      expect(copy.title.length).toBeGreaterThan(0);
      expect(typeof copy.description).toBe("string");
      expect(copy.description.length).toBeGreaterThan(0);
      expect(typeof copy.badgeLabel).toBe("string");
      expect(copy.badgeLabel.length).toBeGreaterThan(0);
      expect(Array.isArray(copy.dataLines)).toBe(true);
      expect(copy.dataLines.length).toBeGreaterThan(0);
    }
  });

  it("Off is the only level where every data line stays local", () => {
    const off = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Off];
    expect(off.dataLines.every((line) => line.kind === "local")).toBe(true);
  });

  it("Full is the only level where every data line syncs", () => {
    const full = DATA_SYNC_LEVEL_COPY[DataSyncLevel.Full];
    expect(full.dataLines.every((line) => line.kind === "sync")).toBe(true);
  });
});
