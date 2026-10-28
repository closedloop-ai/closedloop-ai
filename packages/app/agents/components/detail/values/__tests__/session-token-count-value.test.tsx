import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTokenCountValue } from "../session-token-count-value";

/**
 * PLN-2169 M2: one token counter. The "recorded at all" verdict is the
 * caller's (ISS-5637, summed over the quadruple); this value only honours it.
 */

/** The class the shared sentinel renders with, read rather than hardcoded. */
function sharedEmptyGlyphClassName(): string {
  const { container, unmount } = render(<GridEmptyValue />);
  const className = container.querySelector("span")?.className;
  unmount();
  if (className === undefined) {
    throw new Error("GridEmptyValue did not render a span");
  }
  return className;
}

describe("SessionTokenCountValue", () => {
  it("renders a recorded counter localized", () => {
    const { container } = render(
      <SessionTokenCountValue usageRecorded value={1_204_000} />
    );
    expect(container.textContent).toBe("1,204,000");
  });

  it("keeps a per-counter zero as a measured zero when usage was recorded", () => {
    // ISS-5637: a zero cache half inside a session that consumed real tokens is
    // a measurement, and collapsing it to a dash would swap one lie for another.
    const { container } = render(
      <SessionTokenCountValue usageRecorded value={0} />
    );
    expect(container.textContent).toBe("0");
    expect(container.querySelector("span")).toBeNull();
  });

  it("renders the shared empty glyph for a counter the producer omitted", () => {
    // ISS-5565: per-counter degradation for a version-skewed producer.
    const { container } = render(
      <SessionTokenCountValue usageRecorded value={null} />
    );
    expect(container.textContent).toBe("—");
    expect(container.querySelector("span")?.className).toBe(
      sharedEmptyGlyphClassName()
    );
  });

  it("renders the empty glyph for a zero when no usage was recorded at all", () => {
    // The four zeros both producers emit for a session with no token-usage
    // rows are not measurements; the caller says so and the value obeys.
    const { container } = render(
      <SessionTokenCountValue usageRecorded={false} value={0} />
    );
    expect(container.textContent).toBe("—");
    // ISS-5581: no hover-only `title`; the row states the reason once.
    expect(container.querySelector("[title]")).toBeNull();
  });
});
