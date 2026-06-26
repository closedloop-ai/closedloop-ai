import { describe, expect, it } from "vitest";
import {
  buildSummary,
  categorizeSchema,
  computeExitCode,
  deriveBranchSchemaName,
  getBranchModeCounterBucket,
  isOrphanGraceElapsed,
  makeCounters,
  parseCliArgs,
  validateHost,
} from "../scripts/cleanup-preview-schemas-lib";

// ---------------------------------------------------------------------------
// categorizeSchema
// ---------------------------------------------------------------------------

describe("categorizeSchema", () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const ttlDays = 7;

  it("returns 'active' when registryRow is within ttl", () => {
    const lastSeenAt = new Date("2024-05-29T12:00:00Z"); // 3 days ago — within 7-day TTL
    const result = categorizeSchema({
      schemaName: "preview_main_abc12345",
      registryRow: { lastSeenAt },
      registryTableMissing: false,
      ttlDays,
      now,
    });
    expect(result).toBe("active");
  });

  it("returns 'stale' when registryRow lastSeenAt is older than ttlDays", () => {
    const lastSeenAt = new Date("2024-05-20T12:00:00Z"); // 12 days ago — beyond 7-day TTL
    const result = categorizeSchema({
      schemaName: "preview_old_abc12345",
      registryRow: { lastSeenAt },
      registryTableMissing: false,
      ttlDays,
      now,
    });
    expect(result).toBe("stale");
  });

  it("returns 'active' when lastSeenAt is exactly at the cutoff boundary (equal, not strictly before)", () => {
    // Cutoff is exactly ttlDays ago; the row was last seen exactly at cutoff
    const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
    // lastSeenAt === cutoff means NOT < cutoff, so it should be 'active'
    const result = categorizeSchema({
      schemaName: "preview_boundary_abc12345",
      registryRow: { lastSeenAt: cutoff },
      registryTableMissing: false,
      ttlDays,
      now,
    });
    expect(result).toBe("active");
  });

  it("returns 'orphaned' when registryTableMissing is true (even if registryRow is provided)", () => {
    const lastSeenAt = new Date("2024-05-29T12:00:00Z");
    const result = categorizeSchema({
      schemaName: "preview_nomigration_abc12345",
      registryRow: { lastSeenAt },
      registryTableMissing: true,
      ttlDays,
      now,
    });
    expect(result).toBe("orphaned");
  });

  it("returns 'orphaned' when registryRow is null and registryTableMissing is false", () => {
    const result = categorizeSchema({
      schemaName: "preview_norow_abc12345",
      registryRow: null,
      registryTableMissing: false,
      ttlDays,
      now,
    });
    expect(result).toBe("orphaned");
  });

  it("returns 'orphaned' when both registryTableMissing is true and registryRow is null", () => {
    const result = categorizeSchema({
      schemaName: "preview_norow_nomigration_abc12345",
      registryRow: null,
      registryTableMissing: true,
      ttlDays,
      now,
    });
    expect(result).toBe("orphaned");
  });
});

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------

describe("buildSummary", () => {
  it("formats zeroed counters with all four categories and registry-read suffix", () => {
    const counters = makeCounters();
    const result = buildSummary(counters);
    expect(result).toBe(
      "summary: ttl-expired[dropped=0 kept=0 errored=0] orphan[dropped=0 kept=0 errored=0] orphan-branch[dropped=0 kept=0 errored=0] pr-closed[dropped=0 kept=0 errored=0] registry-read[errored=0]"
    );
  });

  it("reflects non-zero counter values in the output", () => {
    const counters = makeCounters();
    counters["ttl-expired"].dropped = 3;
    counters["ttl-expired"].kept = 1;
    counters.orphan.errored = 2;
    counters["pr-closed"].dropped = 5;
    counters.registryReadErrored = 4;
    const result = buildSummary(counters);
    expect(result).toContain("ttl-expired[dropped=3 kept=1 errored=0]");
    expect(result).toContain("orphan[dropped=0 kept=0 errored=2]");
    expect(result).toContain("orphan-branch[dropped=0 kept=0 errored=0]");
    expect(result).toContain("pr-closed[dropped=5 kept=0 errored=0]");
    expect(result).toContain("registry-read[errored=4]");
  });

  it("always starts with 'summary: '", () => {
    const result = buildSummary(makeCounters());
    expect(result.startsWith("summary: ")).toBe(true);
  });

  it("always contains all four category keys in order, followed by registry-read", () => {
    const result = buildSummary(makeCounters());
    const ttlIdx = result.indexOf("ttl-expired[");
    const orphanIdx = result.indexOf("orphan[");
    const orphanBranchIdx = result.indexOf("orphan-branch[");
    const prClosedIdx = result.indexOf("pr-closed[");
    const registryReadIdx = result.indexOf("registry-read[");
    expect(ttlIdx).toBeGreaterThan(-1);
    expect(orphanIdx).toBeGreaterThan(ttlIdx);
    expect(orphanBranchIdx).toBeGreaterThan(orphanIdx);
    expect(prClosedIdx).toBeGreaterThan(orphanBranchIdx);
    expect(registryReadIdx).toBeGreaterThan(prClosedIdx);
  });
});

// ---------------------------------------------------------------------------
// validateHost
// ---------------------------------------------------------------------------

describe("validateHost", () => {
  it("returns an error when pgHost is undefined", () => {
    const result = validateHost({
      pgHost: undefined,
      stagePgHost: "stage.db.example.com",
    });
    expect(result).toBe("PGHOST is not set");
  });

  it("returns an error when pgHost is an empty string", () => {
    const result = validateHost({
      pgHost: "",
      stagePgHost: "stage.db.example.com",
    });
    expect(result).toBe("PGHOST is not set");
  });

  it("returns an error when stagePgHost is undefined", () => {
    const result = validateHost({
      pgHost: "stage.db.example.com",
      stagePgHost: undefined,
    });
    expect(result).toBe("STAGE_PGHOST is not set; cannot verify host safety");
  });

  it("returns an error when stagePgHost is an empty string", () => {
    const result = validateHost({
      pgHost: "stage.db.example.com",
      stagePgHost: "",
    });
    expect(result).toBe("STAGE_PGHOST is not set; cannot verify host safety");
  });

  it("returns an error when pgHost does not match stagePgHost", () => {
    const result = validateHost({
      pgHost: "prod.db.example.com",
      stagePgHost: "stage.db.example.com",
    });
    expect(result).toBe(
      "PGHOST (prod.db.example.com) does not match STAGE_PGHOST (stage.db.example.com); refusing to run against non-stage host"
    );
  });

  it("returns null when pgHost matches stagePgHost exactly", () => {
    const result = validateHost({
      pgHost: "stage.db.example.com",
      stagePgHost: "stage.db.example.com",
    });
    expect(result).toBeNull();
  });

  it("returns null when pgHost matches stagePgHost case-insensitively", () => {
    const result = validateHost({
      pgHost: "STAGE.DB.EXAMPLE.COM",
      stagePgHost: "stage.db.example.com",
    });
    expect(result).toBeNull();
  });

  it("returns null when stagePgHost has different casing than pgHost", () => {
    const result = validateHost({
      pgHost: "stage.db.example.com",
      stagePgHost: "Stage.DB.Example.COM",
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveBranchSchemaName
// ---------------------------------------------------------------------------

describe("deriveBranchSchemaName", () => {
  it("returns the normalized schema name when it starts with 'preview_'", () => {
    const normalize = (ref: string) => `preview_${ref.replace(/\//g, "_")}`;
    const result = deriveBranchSchemaName("feature/my-branch", normalize);
    expect(result).toBe("preview_feature_my-branch");
    expect(result.startsWith("preview_")).toBe(true);
  });

  it("passes the branch name through the provided normalizer", () => {
    const calls: string[] = [];
    const normalize = (ref: string) => {
      calls.push(ref);
      return `preview_${ref}`;
    };
    deriveBranchSchemaName("my-branch", normalize);
    expect(calls).toEqual(["my-branch"]);
  });

  it("throws when the normalizer returns a name not starting with 'preview_'", () => {
    const badNormalizer = (_ref: string) => "public";
    expect(() => deriveBranchSchemaName("main", badNormalizer)).toThrow(
      'Normalizer produced a non-preview_ schema name "public" for branch "main"; refusing to proceed'
    );
  });

  it("throws when the normalizer returns an empty string", () => {
    const emptyNormalizer = (_ref: string) => "";
    expect(() =>
      deriveBranchSchemaName("my-branch", emptyNormalizer)
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getBranchModeCounterBucket
// ---------------------------------------------------------------------------

describe("getBranchModeCounterBucket", () => {
  it("uses orphan-branch counters for explicit daily branch drops", () => {
    expect(getBranchModeCounterBucket("daily")).toBe("orphan-branch");
  });

  it("uses pr-closed counters for pr-close drops", () => {
    expect(getBranchModeCounterBucket("pr-close")).toBe("pr-closed");
  });
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("defaults: dryRun=false, branch=null, mode='daily' when no args given", () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({ dryRun: false, branch: null, mode: "daily" });
  });

  it("sets dryRun=true when --dry-run flag is present", () => {
    const result = parseCliArgs(["--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  it("sets branch when --branch <name> is provided", () => {
    const result = parseCliArgs(["--branch", "feature/my-branch"]);
    expect(result.branch).toBe("feature/my-branch");
  });

  it("sets mode='daily' when --mode daily is provided", () => {
    const result = parseCliArgs(["--mode", "daily"]);
    expect(result.mode).toBe("daily");
  });

  it("sets mode='pr-close' when --mode pr-close is provided", () => {
    const result = parseCliArgs(["--mode", "pr-close"]);
    expect(result.mode).toBe("pr-close");
  });

  it("throws when --mode receives an invalid value", () => {
    expect(() => parseCliArgs(["--mode", "weekly"])).toThrow(
      'Invalid --mode value "weekly"; expected "daily" or "pr-close"'
    );
  });

  it("accepts combined flags: --dry-run --branch <name> --mode pr-close", () => {
    const result = parseCliArgs([
      "--dry-run",
      "--branch",
      "fix/bug-123",
      "--mode",
      "pr-close",
    ]);
    expect(result).toEqual({
      dryRun: true,
      branch: "fix/bug-123",
      mode: "pr-close",
    });
  });

  it("branch remains null when --branch is not provided", () => {
    const result = parseCliArgs(["--dry-run"]);
    expect(result.branch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeExitCode
// ---------------------------------------------------------------------------

describe("computeExitCode", () => {
  it("returns 0 when all counters are zeroed", () => {
    const result = computeExitCode(makeCounters());
    expect(result).toBe(0);
  });

  it("returns 0 when there are dropped and kept counts but no errors", () => {
    const counters = makeCounters();
    counters["ttl-expired"].dropped = 5;
    counters.orphan.kept = 3;
    counters["pr-closed"].dropped = 2;
    const result = computeExitCode(counters);
    expect(result).toBe(0);
  });

  it("returns 1 when ttl-expired has errored > 0", () => {
    const counters = makeCounters();
    counters["ttl-expired"].errored = 1;
    expect(computeExitCode(counters)).toBe(1);
  });

  it("returns 1 when orphan has errored > 0", () => {
    const counters = makeCounters();
    counters.orphan.errored = 2;
    expect(computeExitCode(counters)).toBe(1);
  });

  it("returns 1 when orphan-branch has errored > 0", () => {
    const counters = makeCounters();
    counters["orphan-branch"].errored = 1;
    expect(computeExitCode(counters)).toBe(1);
  });

  it("returns 1 when pr-closed has errored > 0", () => {
    const counters = makeCounters();
    counters["pr-closed"].errored = 3;
    expect(computeExitCode(counters)).toBe(1);
  });

  it("returns 1 when multiple categories have errors", () => {
    const counters = makeCounters();
    counters["ttl-expired"].errored = 1;
    counters.orphan.errored = 1;
    expect(computeExitCode(counters)).toBe(1);
  });

  it("returns 1 when registryReadErrored > 0 even if no per-category errors", () => {
    const counters = makeCounters();
    counters.registryReadErrored = 1;
    expect(computeExitCode(counters)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// makeCounters
// ---------------------------------------------------------------------------

describe("makeCounters", () => {
  it("returns an object with all four category keys plus registryReadErrored", () => {
    const counters = makeCounters();
    expect(Object.keys(counters)).toEqual([
      "ttl-expired",
      "orphan",
      "orphan-branch",
      "pr-closed",
      "registryReadErrored",
    ]);
  });

  it("initializes all per-category counters to zero", () => {
    const counters = makeCounters();
    for (const cat of [
      "ttl-expired",
      "orphan",
      "orphan-branch",
      "pr-closed",
    ] as const) {
      expect(counters[cat]).toEqual({ kept: 0, dropped: 0, errored: 0 });
    }
  });

  it("initializes registryReadErrored to zero", () => {
    const counters = makeCounters();
    expect(counters.registryReadErrored).toBe(0);
  });

  it("each call returns a fresh independent object", () => {
    const a = makeCounters();
    const b = makeCounters();
    a["ttl-expired"].dropped = 99;
    a.registryReadErrored = 5;
    expect(b["ttl-expired"].dropped).toBe(0);
    expect(b.registryReadErrored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isOrphanGraceElapsed
// ---------------------------------------------------------------------------

describe("isOrphanGraceElapsed", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("returns false when firstObservedAt is null (first observation)", () => {
    expect(isOrphanGraceElapsed(null, 48, now)).toBe(false);
  });

  it("returns false when within the grace window", () => {
    // Observed 24 hours ago, grace window is 48 hours
    const firstObservedAt = new Date("2026-05-31T12:00:00Z");
    expect(isOrphanGraceElapsed(firstObservedAt, 48, now)).toBe(false);
  });

  it("returns false when exactly at the grace boundary (not strictly greater)", () => {
    // Observed exactly 48 hours ago — boundary is not elapsed (> not >=)
    const firstObservedAt = new Date("2026-05-30T12:00:00Z");
    expect(isOrphanGraceElapsed(firstObservedAt, 48, now)).toBe(false);
  });

  it("returns true when past the grace window", () => {
    // Observed 49 hours ago, grace window is 48 hours
    const firstObservedAt = new Date("2026-05-30T11:00:00Z");
    expect(isOrphanGraceElapsed(firstObservedAt, 48, now)).toBe(true);
  });

  it("returns true with zero-hour grace override for previously-observed orphan", () => {
    // Any previously-observed orphan is immediately eligible with graceHours=0
    const firstObservedAt = new Date("2026-06-01T11:59:59Z"); // 1 second ago
    expect(isOrphanGraceElapsed(firstObservedAt, 0, now)).toBe(true);
  });

  it("returns false with zero-hour grace when firstObservedAt is null", () => {
    // Even with zero grace, null means first observation — don't drop
    expect(isOrphanGraceElapsed(null, 0, now)).toBe(false);
  });
});
