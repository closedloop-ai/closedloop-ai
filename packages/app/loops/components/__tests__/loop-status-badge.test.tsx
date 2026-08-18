import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { LoopStatusBadge } from "../loop-status-badge";

const ghostLoopUxEnabled = createStaticFeatureFlagAdapter({
  enabledFlags: ["ghost-loop-ux"],
});

describe("LoopStatusBadge", () => {
  it("uses failed styling for friendly error labels without specific colors", () => {
    render(
      <FeatureFlagAdapterProvider adapter={ghostLoopUxEnabled}>
        <LoopStatusBadge
          errorCode={LoopErrorCode.ProcessFailed}
          status={LoopStatus.Failed}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText("Command failed")).toHaveClass("bg-destructive/10");
  });

  // ISS-5711: a launch failure is now persisted as FAILED/LAUNCH_FAILED rather
  // than as a user cancellation, so this badge is the first place a user learns
  // the run never started. It must read as a failure, not as the inactive tone
  // CANCELLED used to render.
  it("uses failed styling and launch-failure copy for a LAUNCH_FAILED loop", () => {
    render(
      <FeatureFlagAdapterProvider adapter={ghostLoopUxEnabled}>
        <LoopStatusBadge
          errorCode={LoopErrorCode.LaunchFailed}
          status={LoopStatus.Failed}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText("The run could not be started")).toHaveClass(
      "bg-destructive/10"
    );
  });

  // A newer producer can emit an error code this client has never heard of.
  // It must still render a styled failure badge rather than an unstyled state.
  it("falls back to failed styling for an unknown error code", () => {
    render(
      <FeatureFlagAdapterProvider adapter={ghostLoopUxEnabled}>
        <LoopStatusBadge
          errorCode="SOME_FUTURE_CODE"
          status={LoopStatus.Failed}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText("Operation failed")).toHaveClass(
      "bg-destructive/10"
    );
  });

  // A genuine user cancellation keeps its inactive tone and its own label --
  // the direction ISS-5711 must not over-correct.
  it("keeps the inactive cancelled label for a user-cancelled loop", () => {
    render(
      <FeatureFlagAdapterProvider adapter={ghostLoopUxEnabled}>
        <LoopStatusBadge status={LoopStatus.Cancelled} />
      </FeatureFlagAdapterProvider>
    );

    const badge = screen.getByText("Cancelled");
    expect(badge).not.toHaveClass("bg-destructive/10");
  });
});
