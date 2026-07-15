import { describe, expect, it } from "vitest";
import { parseIngest, parseMaintenance } from "../use-ingest-progress";

// The runtime status payload is produced by collectorManager.getIngestProgress()
// in the main process (same-version, same package) and projected here. These
// tests pin the producer/consumer shape so the two never drift, and the
// null-degradation for a not-yet-ready runtime.
describe("parseIngest", () => {
  it("returns the ingest projection verbatim for a well-formed payload", () => {
    const ingest = {
      byHarness: [
        { harness: "codex", total: 100, processed: 40 },
        { harness: "claude", total: 50, processed: 10 },
      ],
      total: 150,
      processed: 50,
      preparing: false,
      complete: true,
    };
    expect(parseIngest({ ingest })).toEqual(ingest);
  });

  it("returns null when the ingest field is absent (runtime not up yet)", () => {
    expect(parseIngest(null)).toBeNull();
    expect(parseIngest(42)).toBeNull();
    expect(parseIngest({})).toBeNull();
    expect(parseIngest({ ingest: null })).toBeNull();
  });
});

// The maintenance payload is produced by the runtime's getMaintenanceProgress()
// (FEA-2264) and projected here. These tests pin the producer/consumer shape so
// the first-launch banner's maintenance window can never drift.
describe("parseMaintenance", () => {
  it("returns the maintenance projection verbatim for a well-formed payload", () => {
    expect(
      parseMaintenance({ maintenance: { active: true, phase: "rebuild" } })
    ).toEqual({ active: true, phase: "rebuild" });
    expect(
      parseMaintenance({
        maintenance: { active: true, phase: "artifact-links" },
      })
    ).toEqual({ active: true, phase: "artifact-links" });
    expect(
      parseMaintenance({ maintenance: { active: false, phase: null } })
    ).toEqual({ active: false, phase: null });
  });

  it("returns null when the maintenance field is absent (runtime not up yet)", () => {
    expect(parseMaintenance(null)).toBeNull();
    expect(parseMaintenance(42)).toBeNull();
    expect(parseMaintenance({})).toBeNull();
    expect(parseMaintenance({ maintenance: null })).toBeNull();
  });
});
