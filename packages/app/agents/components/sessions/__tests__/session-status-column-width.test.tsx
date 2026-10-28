import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStatusColumnWidth } from "../use-session-status-column-width";

function Table({ labels }: { labels: string[] }) {
  const root = useRef<HTMLDivElement>(null);
  const width = useSessionStatusColumnWidth(root);
  return (
    <div data-testid="table" data-width={width} ref={root}>
      <table>
        <tbody>
          {labels.map((label) => (
            <tr key={label}>
              <td
                data-column-id="status"
                // biome-ignore lint/a11y/noRedundantRoles: exercise the production grid cell selector.
                role="cell"
                style={{
                  paddingLeft: 12,
                  paddingRight: 12,
                  // Load-bearing, not decoration: `border-*-width` computes to
                  // 0 while `border-*-style` is `none`, so without this the
                  // 1px below never reaches the hook's sum. Measured 0px vs
                  // 1px in chromium, firefox and webkit; jsdom below 30
                  // answered 1px either way, which is the bug jsdom 30 fixed.
                  borderLeftStyle: "solid",
                  borderLeftWidth: 1,
                }}
              >
                <span>{label}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Status column content fit", () => {
  it("uses the largest displayed badge plus cell padding and updates when rows change", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return new DOMRect(
          0,
          0,
          this.textContent === "In progress · Running" ? 180 : 96,
          24
        );
      }
    );
    const { rerender } = render(
      <Table labels={["Done · Completed", "In progress · Running"]} />
    );
    expect(screen.getByTestId("table")).toHaveAttribute("data-width", "205");
    act(() => rerender(<Table labels={["Done · Completed"]} />));
    expect(screen.getByTestId("table")).toHaveAttribute("data-width", "121");
  });

  it("sizes to a badge the cell is already clipping, not to the clipped box", () => {
    // The V2 grid cell is `overflow-hidden` with `[&>*]:min-w-0`, so a badge
    // wider than the column has ALREADY shrunk: its border box reports the
    // column's own width. Measuring that is a fixed point — the column can
    // never grow past where it started. `scrollWidth` is the unshrunk content.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, CLIPPED_BOX_PX, 24)
    );
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(
      function (this: Element) {
        return this.tagName === "SPAN" ? UNCLIPPED_CONTENT_PX : 0;
      }
    );

    render(<Table labels={["In progress · Running"]} />);

    // 180 content + 12 + 12 padding + 1 border. The pre-fix measurement would
    // have answered 96 + 25 = 121 — the column it was trying to widen.
    expect(screen.getByTestId("table")).toHaveAttribute("data-width", "205");
  });
});

/** The width the cell has shrunk the badge to — the column's current width. */
const CLIPPED_BOX_PX = 96;
/** The width the badge's text actually needs. */
const UNCLIPPED_CONTENT_PX = 180;
