import { EngineerRoutingMode } from "@repo/api/src/types/relay";
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

    setEngineerRoutingManualSelection(
      EngineerRoutingMode.CloudRelay,
      "target-1"
    );
    setEngineerRoutingAutoSelection(EngineerRoutingMode.LocalElectron, null);

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe(EngineerRoutingMode.CloudRelay);
    expect(snapshot.computeTargetId).toBe("target-1");
    expect(snapshot.source).toBe("manual");
  });

  it("allows forced auto override for invalid manual selections", () => {
    resetEngineerRoutingSelectionForTests();

    setEngineerRoutingManualSelection(EngineerRoutingMode.LocalElectron, null);
    setEngineerRoutingAutoSelection(
      EngineerRoutingMode.CloudRelay,
      "target-2",
      {
        force: true,
      }
    );

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe(EngineerRoutingMode.CloudRelay);
    expect(snapshot.computeTargetId).toBe("target-2");
    expect(snapshot.source).toBe("auto");
  });

  it("drops compute target id for non-cloud modes", () => {
    resetEngineerRoutingSelectionForTests();

    setEngineerRoutingManualSelection(EngineerRoutingMode.LocalDev, "target-3");

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe(EngineerRoutingMode.LocalDev);
    expect(snapshot.computeTargetId).toBeNull();
  });
});
