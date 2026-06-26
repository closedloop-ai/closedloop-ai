import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { FeatureFlagged } from "../feature-flagged";
import { FeatureFlagAdapterProvider } from "../provider";
import { createStaticFeatureFlagAdapter } from "../static-feature-flag-adapter";

function renderWithFlags(ui: ReactNode, enabledFlags: readonly string[] = []) {
  const adapter = createStaticFeatureFlagAdapter({ enabledFlags });
  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

describe("FeatureFlagged", () => {
  it("renders children when the flag is enabled", () => {
    renderWithFlags(<FeatureFlagged flag="beta">visible</FeatureFlagged>, [
      "beta",
    ]);

    expect(screen.getByText("visible")).toBeInTheDocument();
  });

  it("renders nothing when the flag is disabled", () => {
    renderWithFlags(<FeatureFlagged flag="beta">hidden</FeatureFlagged>);

    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });
});
