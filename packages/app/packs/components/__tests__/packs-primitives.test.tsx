/**
 * @file packs-primitives.test.tsx
 * @description Render tests for the shared Packs page primitives promoted from
 * the reviewed prototype in FEA-4087 Slice 1 (`PageSection`, `PackListRow`,
 * `SourceStatusLine`). The sibling treatments (FEA-4088/4089) compose these;
 * these tests pin the contract each one exposes — the labelled region, the
 * divided list row, and the never-color-alone status line.
 */
import { render, screen } from "@testing-library/react";
import { TriangleAlertIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { PackListRow } from "../pack-list-row";
import { PageSection } from "../page-section";
import { SourceStatusLine, StatusTone } from "../source-status-line";

describe("PageSection", () => {
  it("names the region by its title and renders its body", () => {
    render(
      <PageSection description="what lives here" title="Packs you distribute">
        <div data-testid="body" />
      </PageSection>
    );

    expect(
      screen.getByRole("region", { name: "Packs you distribute" })
    ).toBeInTheDocument();
    expect(screen.getByText("what lives here")).toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("renders the trailing action slot", () => {
    render(
      <PageSection
        action={<button type="button">Add packs</button>}
        title="Add packs"
      >
        <div />
      </PageSection>
    );

    expect(
      screen.getByRole("button", { name: "Add packs" })
    ).toBeInTheDocument();
  });
});

describe("PackListRow", () => {
  it("renders the pack identity, version, and action", () => {
    render(
      <PackListRow
        action={<button type="button">Install</button>}
        description="Generates test skeletons from a diff."
        name="Test Scaffolder"
        publisher="DevEx"
        version="2.6.0"
      />
    );

    expect(screen.getByText("Test Scaffolder")).toBeInTheDocument();
    expect(screen.getByText("2.6.0")).toBeInTheDocument();
    expect(
      screen.getByText("DevEx · Generates test skeletons from a diff.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  });
});

describe("SourceStatusLine", () => {
  it("renders text alongside the icon (meaning never rides on color alone)", () => {
    render(
      <SourceStatusLine
        icon={TriangleAlertIcon}
        text="4 failed"
        tone={StatusTone.Danger}
      />
    );

    // The words carry the meaning; the glyph is decorative (aria-hidden).
    expect(screen.getByText("4 failed")).toBeInTheDocument();
  });

  it("renders the optional description line", () => {
    render(
      <SourceStatusLine
        description="Auto-installed for every targeted member"
        icon={TriangleAlertIcon}
        text="Required"
      />
    );

    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(
      screen.getByText("Auto-installed for every targeted member")
    ).toBeInTheDocument();
  });
});
