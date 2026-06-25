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
});
