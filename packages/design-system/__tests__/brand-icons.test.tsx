// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubMark } from "../components/ui/brand-icons";

/**
 * FEA-3570 routed every GitHub logo in the product and on the marketing site
 * through this one component, so what makes it a LOGO rather than lucide's
 * line-art glyph is now a contract eleven surfaces depend on. Nothing else
 * asserts it: an edit here that reintroduced a stroked, hollow body would leave
 * every call site compiling, every gate still flipping, and every surface
 * quietly back to the outline this ticket removed.
 *
 * Pinned as literal SVG facts rather than by re-reading the component's own
 * markup, so the assertion cannot move with the thing it polices.
 */
describe("GitHubMark", () => {
  it("is the filled Invertocat, not a stroked outline", () => {
    const { container } = render(<GitHubMark />);
    const svg = container.querySelector("svg");

    // A filled body: painted with the current colour and never stroked.
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("stroke")).toBeNull();
    // One path is the silhouette. lucide's outline needs two — a head outline
    // plus the tail — because the body it draws is transparent.
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
  });

  it("lets a caller size it and label it", () => {
    // Every call site sizes the mark with a utility class and several sit
    // inside a labelled link, so a spread that dropped incoming props would
    // ship a 16px logo with the wrong accessible name.
    const { container } = render(
      <GitHubMark aria-hidden={false} aria-label="GitHub" className="size-6" />
    );
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("class")).toContain("size-6");
    expect(svg?.getAttribute("aria-label")).toBe("GitHub");
    expect(svg?.getAttribute("aria-hidden")).toBe("false");
  });
});
