import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseFeatureFlag } = vi.hoisted(() => ({
  mockUseFeatureFlag: vi.fn(),
}));

vi.mock("../client", () => ({
  useFeatureFlag: mockUseFeatureFlag,
}));

import { FeatureFlagged } from "./feature-flagged";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FeatureFlagged", () => {
  it("renders the hook-enabled feature after mounting", () => {
    mockUseFeatureFlag.mockReturnValue({ enabled: true, key: "new-ui" });

    render(
      <FeatureFlagged flag="new-ui">
        <div>Enabled content</div>
      </FeatureFlagged>
    );

    expect(screen.getByText("Enabled content")).toBeTruthy();
    expect(mockUseFeatureFlag).toHaveBeenCalledWith("new-ui");
  });

  it("renders a supplied fallback when the hook disables the feature", () => {
    mockUseFeatureFlag.mockReturnValue({ enabled: false, key: "new-ui" });

    render(
      <FeatureFlagged fallback={<div>Existing content</div>} flag="new-ui">
        <div>Enabled content</div>
      </FeatureFlagged>
    );

    expect(screen.getByText("Existing content")).toBeTruthy();
    expect(screen.queryByText("Enabled content")).toBeNull();
  });

  it("lets an explicit enabled prop override the hook result", () => {
    mockUseFeatureFlag.mockReturnValue({ enabled: false, key: "new-ui" });

    render(
      <FeatureFlagged enabled flag="new-ui">
        <div>Forced content</div>
      </FeatureFlagged>
    );

    expect(screen.getByText("Forced content")).toBeTruthy();
  });

  it("uses the default null fallback for an unresolved feature", () => {
    mockUseFeatureFlag.mockReturnValue(undefined);

    const { container } = render(
      <FeatureFlagged flag="new-ui">
        <div>Enabled content</div>
      </FeatureFlagged>
    );

    expect(container.textContent).toBe("");
  });
});
