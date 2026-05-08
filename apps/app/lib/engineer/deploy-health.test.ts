import { describe, expect, it } from "vitest";
import {
  MountDeployHealthAction,
  resolveMountDeployHealthAction,
} from "@/lib/engineer/deploy-health";

describe("resolveMountDeployHealthAction", () => {
  it("clears deployed entries for policy-denied alive:false responses", () => {
    expect(
      resolveMountDeployHealthAction({ healthCheckFailed: false }, {
        alive: false,
        statusCode: null,
        code: "OUTBOUND_URL_DENIED",
      } as never)
    ).toBe(MountDeployHealthAction.ClearDeployment);
  });

  it("resets failure state when the health check recovers", () => {
    expect(
      resolveMountDeployHealthAction(
        { healthCheckFailed: true },
        { alive: true }
      )
    ).toBe(MountDeployHealthAction.ResetFailure);
  });

  it("does nothing for healthy entries that were not marked failed", () => {
    expect(
      resolveMountDeployHealthAction(
        { healthCheckFailed: false },
        { alive: true }
      )
    ).toBe(MountDeployHealthAction.Noop);
  });
});
