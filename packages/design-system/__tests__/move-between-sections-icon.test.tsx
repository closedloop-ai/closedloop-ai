import { MoveBetweenSectionsIcon } from "@closedloop-ai/design-system/components/ui/move-between-sections-icon";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * The icon is decorative: it only ever sits next to a control that already
 * carries the accessible name, so it must stay out of the accessibility tree
 * and out of the tab order. It also has to forward `size` and `className`,
 * because every caller sizes it against a DS spacing step rather than the
 * 12px default.
 */
describe("MoveBetweenSectionsIcon", () => {
  it("stays out of the accessibility tree and the tab order", () => {
    const { container } = render(<MoveBetweenSectionsIcon />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
  });

  it("defaults to 12px and forwards an explicit size to both axes", () => {
    const { container: defaulted } = render(<MoveBetweenSectionsIcon />);
    const defaultSvg = defaulted.querySelector("svg");
    expect(defaultSvg?.getAttribute("width")).toBe("12");
    expect(defaultSvg?.getAttribute("height")).toBe("12");

    const { container: sized } = render(<MoveBetweenSectionsIcon size={20} />);
    const sizedSvg = sized.querySelector("svg");
    expect(sizedSvg?.getAttribute("width")).toBe("20");
    expect(sizedSvg?.getAttribute("height")).toBe("20");
  });

  it("merges a caller className with the base classes rather than replacing them", () => {
    const { container } = render(
      <MoveBetweenSectionsIcon className="text-muted-foreground" />
    );
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");
    expect(svg?.getAttribute("class")).toContain("shrink-0");
    expect(svg?.getAttribute("class")).toContain("fill-current");
  });
});
