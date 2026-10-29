import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
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

  it("renders the fallback when the flag is disabled", () => {
    renderWithFlags(
      <FeatureFlagged fallback="fallback shown" flag="beta">
        hidden
      </FeatureFlagged>
    );

    expect(screen.getByText("fallback shown")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });

  it("renders the children, not the fallback, when the flag is enabled", () => {
    renderWithFlags(
      <FeatureFlagged fallback="fallback shown" flag="beta">
        visible
      </FeatureFlagged>,
      ["beta"]
    );

    expect(screen.getByText("visible")).toBeInTheDocument();
    expect(screen.queryByText("fallback shown")).not.toBeInTheDocument();
  });

  it("renders neither the children nor the fallback before mount", () => {
    const adapter = createStaticFeatureFlagAdapter({ enabledFlags: ["beta"] });
    const html = renderToString(
      <FeatureFlagAdapterProvider adapter={adapter}>
        <div data-testid="enabled">
          <FeatureFlagged fallback="fallback shown" flag="beta">
            visible
          </FeatureFlagged>
        </div>
        <div data-testid="disabled">
          <FeatureFlagged fallback="fallback shown" flag="other">
            hidden
          </FeatureFlagged>
        </div>
      </FeatureFlagAdapterProvider>
    );

    expect(html).toBe(
      '<div data-testid="enabled"></div><div data-testid="disabled"></div>'
    );
  });
});
