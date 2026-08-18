import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  GitHubConnectReturnNotice,
  GitHubConnectReturnVariant,
} from "../github-connect-return-notice";

// Raw Tailwind scales the tokenized banner must never emit — matching only one
// utility would let its siblings (border-*/text-*) leak through undetected.
const RAW_EMERALD_UTILITIES = [
  "bg-emerald-50",
  "border-emerald-200",
  "text-emerald-900",
];
const RAW_RED_UTILITIES = ["bg-red-50", "border-red-200", "text-red-900"];

describe("GitHubConnectReturnNotice (FEA-4067)", () => {
  it("renders the connected state through the DS Alert success tokens", () => {
    render(
      <GitHubConnectReturnNotice status={GitHubConnectReturnStatus.Connected} />
    );

    const alert = screen.getByRole("status");
    expect(alert).toHaveTextContent(
      "GitHub is connected. Branch data is refreshing."
    );
    // Tokenized success treatment — semantic tokens, not raw emerald scales.
    expect(alert.className).toContain("bg-success/12");
    expect(alert.className).toContain("border-success/30");
    for (const utility of RAW_EMERALD_UTILITIES) {
      expect(alert.className).not.toContain(utility);
    }
  });

  it("announces the passive connected confirmation politely, not assertively", () => {
    render(
      <GitHubConnectReturnNotice status={GitHubConnectReturnStatus.Connected} />
    );

    const alert = screen.getByRole("status");
    expect(alert).toHaveAttribute("aria-live", "polite");
    // The passive confirmation must not interrupt as an assertive alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the error state through the DS Alert destructive tokens", () => {
    render(
      <GitHubConnectReturnNotice status={GitHubConnectReturnStatus.Error} />
    );

    // Error keeps Alert's default assertive role="alert".
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "GitHub did not connect. Local branch data is still available."
    );
    // Tokenized error treatment — semantic tokens, not raw red scales.
    expect(alert.className).toContain("bg-destructive/12");
    expect(alert.className).toContain("border-destructive/30");
    for (const utility of RAW_RED_UTILITIES) {
      expect(alert.className).not.toContain(utility);
    }
  });

  it("puts the copy in Alert's content column via AlertDescription", () => {
    render(
      <GitHubConnectReturnNotice status={GitHubConnectReturnStatus.Error} />
    );

    // AlertDescription lands the copy in the grid content column so a no-icon
    // Alert (grid-cols-[0_1fr]) doesn't squeeze the text to one word per line.
    const description = screen
      .getByRole("alert")
      .querySelector('[data-slot="alert-description"]');
    expect(description).not.toBeNull();
    expect(description).toHaveTextContent(
      "GitHub did not connect. Local branch data is still available."
    );
  });

  it("renders the detail-variant chrome without changing the copy", () => {
    render(
      <GitHubConnectReturnNotice
        status={GitHubConnectReturnStatus.Connected}
        variant={GitHubConnectReturnVariant.Detail}
      />
    );

    const alert = screen.getByRole("status");
    // Copy is identical across variants; only chrome differs.
    expect(alert).toHaveTextContent(
      "GitHub is connected. Branch data is refreshing."
    );
    // Detail chrome drops the rounded card for a bottom-border banner.
    expect(alert.className).toContain("rounded-none");
    expect(alert.className).toContain("border-x-0");
    // Still the tokenized success treatment.
    expect(alert.className).toContain("bg-success/12");
  });

  it("renders the detail-variant error state through destructive tokens", () => {
    render(
      <GitHubConnectReturnNotice
        status={GitHubConnectReturnStatus.Error}
        variant={GitHubConnectReturnVariant.Detail}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "GitHub did not connect. Local branch data is still available."
    );
    expect(alert.className).toContain("bg-destructive/12");
    for (const utility of RAW_RED_UTILITIES) {
      expect(alert.className).not.toContain(utility);
    }
  });

  it("renders nothing for a missing or unrecognized status", () => {
    const { container, rerender } = render(
      <GitHubConnectReturnNotice status={null} />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();

    rerender(<GitHubConnectReturnNotice status="pending" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
