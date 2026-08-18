/**
 * @file install-source-label.test.tsx
 * @description Render tests for the FEA-4090 non-color-only source indicator.
 * Asserts the label renders text with an accessible description (WCAG 1.4.1 —
 * meaning is carried by text, not color) and that an unknown / legacy source
 * falls back to a generic "Installed" label instead of blank.
 */

import { DistributionMode } from "@repo/api/src/types/distribution";
import {
  InstallOrigin,
  InstallSource,
} from "@repo/api/src/types/install-source";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  InstallSourceLabel,
  ResolvedInstallSourceLabel,
} from "../install-source-label";

describe("InstallSourceLabel", () => {
  it("renders a text label for every canonical source (meaning is not color-only)", () => {
    const cases: [InstallSource, string][] = [
      [InstallSource.Pushed, "Auto-installed"],
      [InstallSource.OptedIn, "Opted in"],
      [InstallSource.Self, "Self-installed"],
      [InstallSource.Required, "Required"],
      [InstallSource.Unknown, "Installed"],
    ];
    for (const [source, label] of cases) {
      const { unmount } = render(<InstallSourceLabel source={source} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("carries an accessible description via title (no em dashes in copy)", () => {
    render(<InstallSourceLabel source={InstallSource.Required} />);
    expect(
      screen.getByTitle("Required by your organization, cannot be removed.")
    ).toBeInTheDocument();
  });

  it("falls back to a generic 'Installed' label for an unmapped source", () => {
    render(
      <InstallSourceLabel source={"totally-unknown-source" as InstallSource} />
    );
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });

  it("resolves + renders from raw distribution linkage", () => {
    // A linkage-capable payload with no link → self-installed.
    render(<ResolvedInstallSourceLabel linkageKnown={true} />);
    expect(screen.getByText("Self-installed")).toBeInTheDocument();
  });

  it("renders the generic label when linkage cannot be reported", () => {
    render(<ResolvedInstallSourceLabel />);
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });

  it("renders from a durable recorded origin, ignoring stale policy fields", () => {
    // A self-installed pack whose current policy reconciled to auto_install
    // still reads "Self-installed" because the durable origin wins.
    render(
      <ResolvedInstallSourceLabel
        distributionMode={DistributionMode.AutoInstall}
        recordedOrigin={InstallOrigin.SelfInstalled}
      />
    );
    expect(screen.getByText("Self-installed")).toBeInTheDocument();
  });
});
