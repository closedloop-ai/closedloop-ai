import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BranchRowStatus } from "../../lib/branch-row";
import { renderBranchStatus } from "../branch-status";

function renderStatus(status: BranchRowStatus, enabled: boolean) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY] : [],
      })}
    >
      {renderBranchStatus({ status }, "branch-1")}
    </FeatureFlagAdapterProvider>
  );
}

describe("Branch status universal adoption", () => {
  it("keeps the exact legacy words while the gate is closed", () => {
    renderStatus(BranchRowStatus.Review, false);
    expect(screen.getByText("In review")).toBeInTheDocument();
  });

  it("uses canonical review wording when the gate is enabled", () => {
    renderStatus(BranchRowStatus.Review, true);
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("distinguishes a closed PR from a merged branch", () => {
    const closed = renderStatus(BranchRowStatus.Closed, true);
    expect(screen.getByText("Closed without merge")).toBeInTheDocument();
    closed.unmount();

    renderStatus(BranchRowStatus.Merged, true);
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.queryByText("Closed without merge")).not.toBeInTheDocument();
  });

  it("preserves unrecognized producer evidence instead of displaying the legacy Draft fallback", () => {
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
        })}
      >
        {renderBranchStatus(
          { rawStatus: "awaiting-robot-review", status: BranchRowStatus.Draft },
          "branch-1"
        )}
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Drafting")).not.toBeInTheDocument();
  });
});
