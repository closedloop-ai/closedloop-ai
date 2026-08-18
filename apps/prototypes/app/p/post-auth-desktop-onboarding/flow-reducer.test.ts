import { describe, expect, it } from "vitest";
import { type FlowAction, flowReducer, Phase } from "./flow-reducer";

describe("post-auth onboarding flowReducer", () => {
  it("dismisses the takeover to the Sessions page once sync is saved", () => {
    expect(flowReducer(Phase.SyncTakeover, { type: "finish-sync" })).toBe(
      Phase.Sessions
    );
  });

  it("restarts back to the blocking takeover from any phase", () => {
    expect(flowReducer(Phase.Sessions, { type: "restart" })).toBe(
      Phase.SyncTakeover
    );
    expect(flowReducer(Phase.SyncTakeover, { type: "restart" })).toBe(
      Phase.SyncTakeover
    );
  });

  it("keeps the current phase when finish-sync fires outside the takeover", () => {
    // finish-sync must not re-fire once already on the Sessions page.
    expect(flowReducer(Phase.Sessions, { type: "finish-sync" })).toBe(
      Phase.Sessions
    );
  });

  it("keeps the current phase for an unknown action", () => {
    const unknown = { type: "noop" } as unknown as FlowAction;
    expect(flowReducer(Phase.SyncTakeover, unknown)).toBe(Phase.SyncTakeover);
  });
});
