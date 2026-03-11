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

  it("falls back to CloudRelay when localStorage contains a legacy local-dev mode", () => {
    resetEngineerRoutingSelectionForTests();

    globalThis.localStorage.setItem(
      "engineer-routing-selection:v1",
      JSON.stringify({
        mode: "local-dev",
        computeTargetId: null,
        source: "auto",
        updatedAt: 1,
      })
    );

    const snapshot = getEngineerRoutingSelection();
    expect(snapshot.mode).toBe(EngineerRoutingMode.CloudRelay);
  });
});
