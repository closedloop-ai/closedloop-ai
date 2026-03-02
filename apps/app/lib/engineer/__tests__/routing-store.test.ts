import { describe, expect, it } from "vitest";
import {
  getEngineerRoutingSelection,
  resetEngineerRoutingSelectionForTests,
  setEngineerRoutingAutoSelection,
  setEngineerRoutingManualSelection,
} from "@/lib/engineer/routing-store";

describe("routing-store", () => {
  it("keeps manual selection when auto updates are not forced", () => {
    resetEngineerRoutingSelectionForTests();

    setEngineerRoutingManualSelection("cloud-relay", "target-1");
    setEngineerRoutingAutoSelection("local-electron", null);

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe("cloud-relay");
    expect(snapshot.computeTargetId).toBe("target-1");
    expect(snapshot.source).toBe("manual");
  });

  it("allows forced auto override for invalid manual selections", () => {
    resetEngineerRoutingSelectionForTests();

    setEngineerRoutingManualSelection("local-electron", null);
    setEngineerRoutingAutoSelection("cloud-relay", "target-2", {
      force: true,
    });

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe("cloud-relay");
    expect(snapshot.computeTargetId).toBe("target-2");
    expect(snapshot.source).toBe("auto");
  });

  it("drops compute target id for non-cloud modes", () => {
    resetEngineerRoutingSelectionForTests();

    setEngineerRoutingManualSelection("local-dev", "target-3");

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe("local-dev");
    expect(snapshot.computeTargetId).toBeNull();
  });
});
