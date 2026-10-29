import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { TrayState } from "../src/main/tray.js";
import {
  refreshDesktopTrayState,
  type TrayStateInputs,
} from "../src/main/tray-state.js";

describe("desktop tray state projection", () => {
  test("applies the documented severity order", () => {
    assert.deepEqual(
      project({ gatewayHealthy: false, agentMonitorFailed: true }),
      {
        state: "error",
        details: "Gateway down on port 3210",
      }
    );
    assert.deepEqual(
      project({ agentMonitorFailed: true, cloudCommandsPaused: true }),
      { state: "degraded", details: "agent monitor failed" }
    );
    assert.deepEqual(project({ cloudCommandsPaused: true }), {
      state: "degraded",
      details: "Serving on localhost:3210 | cloud commands paused",
    });
  });

  test("projects each cloud state after higher-severity signals clear", () => {
    assert.deepEqual(
      project({ cloudStatus: { state: "online", targetId: "target-1" } }),
      {
        state: "ready",
        details: "Serving on localhost:3210 | cloud: online (target-1)",
      }
    );
    assert.deepEqual(
      project({ cloudStatus: { state: "degraded", error: "offline" } }),
      {
        state: "degraded",
        details: "Serving on localhost:3210 | cloud degraded: offline",
      }
    );
    assert.deepEqual(project({ cloudStatus: { state: "idle" } }), {
      state: "ready",
      details: "Serving on localhost:3210 | cloud: connecting",
    });
  });

  test("uses the fallback monitor detail and honors explicit details", () => {
    assert.deepEqual(
      project({ agentMonitorFailed: true, agentMonitorFailureReason: null }),
      {
        state: "degraded",
        details: "Serving on localhost:3210 | agent monitor unavailable",
      }
    );
    assert.deepEqual(project({ gatewayHealthy: false }, "operator detail"), {
      state: "error",
      details: "operator detail",
    });
    assert.deepEqual(
      project(
        { cloudStatus: { state: "online", targetId: "target-1" } },
        "operator detail"
      ),
      { state: "ready", details: "operator detail" }
    );
  });
});

function project(
  overrides: Partial<Omit<TrayStateInputs, "tray" | "getActivePort">>,
  explicitDetails?: string
): { state: TrayState; details: string | undefined } {
  let projected: { state: TrayState; details: string | undefined } | undefined;
  const tray = {
    setState(state: TrayState, details?: string) {
      projected = { state, details };
    },
  } as TrayStateInputs["tray"];
  refreshDesktopTrayState(
    {
      tray,
      gatewayHealthy: true,
      getActivePort: () => 3210,
      agentMonitorFailed: false,
      agentMonitorFailureReason: "agent monitor failed",
      cloudCommandsPaused: false,
      cloudStatus: { state: "idle" },
      ...overrides,
    },
    explicitDetails
  );
  if (!projected) {
    throw new Error("expected a projected tray state");
  }
  return projected;
}
