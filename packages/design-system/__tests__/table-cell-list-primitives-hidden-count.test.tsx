import {
  type TableReference,
  TableReferenceListCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-list-primitives";
import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ONE_REFERENCE: readonly TableReference[] = [
  { id: "ref-1", label: "REF-1", tooltip: "Reference one" },
];

const THREE_REFERENCES: readonly TableReference[] = [
  { id: "ref-1", label: "REF-1", tooltip: "Reference one" },
  { id: "ref-2", label: "REF-2", tooltip: "Reference two" },
  { id: "ref-3", label: "REF-3", tooltip: "Reference three" },
];

const TWO_PLAIN_REFERENCES: readonly TableReference[] = [
  { id: "ref-1", label: "REF-1" },
  { id: "ref-2", label: "REF-2" },
];

const OVERFLOW_PILL_PATTERN = /^\+\d/;
/** Wider than the pill pattern on purpose: a `+NaN` or `+Infinity` pill has no digit. */
const ANY_PILL_PATTERN = /^\+/;

function renderCell(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/**
 * A reference's label renders twice whenever it fits — once in the live chip
 * list, once in the `aria-hidden` measurement clone that widths every
 * reference regardless of fit — and once only (the clone) when it overflows.
 * That count is the fit outcome; a plain `getByText` throws on the first
 * "fits" case instead of answering it.
 */
function labelOccurrences(text: string): number {
  return screen.getAllByText(text).length;
}

/**
 * `useMeasuredCellItems` reads `offsetWidth`/`clientWidth` straight off the
 * DOM rather than off the `ResizeObserver` entry, so a fixed layout needs
 * these two stubbed on the prototype — the package's global `ResizeObserver`
 * shim (`vitest-jsdom-setup`) only supplies the callback trigger, not the
 * widths it re-reads when the callback fires.
 */
function stubMeasuredLayout(offsetWidthPx: number, clientWidthPx: number) {
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
  );
  const previousClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => offsetWidthPx,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => clientWidthPx,
  });
  return () => {
    if (previousOffsetWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        previousOffsetWidth
      );
    }
    if (previousClientWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        previousClientWidth
      );
    }
  };
}

describe("TableReferenceListCell hidden reference count (ISS-9317)", () => {
  let restoreLayout: (() => void) | null = null;

  afterEach(() => {
    restoreLayout?.();
    restoreLayout = null;
  });

  it("renders a single reference with no pill when the count is absent", () => {
    renderCell(<TableReferenceListCell references={ONE_REFERENCE} />);

    expect(labelOccurrences("REF-1")).toBe(2);
    expect(screen.queryByText(OVERFLOW_PILL_PATTERN)).not.toBeInTheDocument();
  });

  it("counts all three references into the pill when jsdom measures zero width", () => {
    renderCell(<TableReferenceListCell references={THREE_REFERENCES} />);

    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("adds a withheld count to the pill and states it on its own tooltip line", () => {
    renderCell(
      <TableReferenceListCell
        hiddenReferenceCount={2}
        references={ONE_REFERENCE}
      />
    );
    const pill = screen.getByText("+3");

    // Radix opens on hover only after its delay timer; focus opens the same
    // tooltip instantly, which is what a keyboard user gets too, so this
    // reaches the identical content without a real-clock wait.
    fireEvent.focus(pill);
    const tooltip = screen.getByRole("tooltip");

    expect(tooltip).toHaveTextContent("Reference one");
    expect(tooltip).toHaveTextContent("2 more not shown here");
  });

  it("uses the same singular copy for a withheld count of one", () => {
    renderCell(
      <TableReferenceListCell
        hiddenReferenceCount={1}
        references={ONE_REFERENCE}
      />
    );
    const pill = screen.getByText("+2");

    fireEvent.focus(pill);
    const tooltip = screen.getByRole("tooltip");

    expect(tooltip).toHaveTextContent("1 more not shown here");
  });

  it("treats an explicit zero the same as an absent count", () => {
    renderCell(
      <TableReferenceListCell
        hiddenReferenceCount={0}
        references={ONE_REFERENCE}
      />
    );

    expect(labelOccurrences("REF-1")).toBe(2);
    expect(screen.queryByText(OVERFLOW_PILL_PATTERN)).not.toBeInTheDocument();
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -3],
    ["fractional", 1.5],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
  ])(
    "renders no pill for a %s count — the prop type is not a runtime guard",
    (_label, count) => {
      renderCell(
        <TableReferenceListCell
          hiddenReferenceCount={count}
          references={ONE_REFERENCE}
        />
      );

      expect(labelOccurrences("REF-1")).toBe(2);
      expect(screen.queryByText(ANY_PILL_PATTERN)).not.toBeInTheDocument();
    }
  );

  it("fits both chips at a width the pill never needs to reserve for", () => {
    restoreLayout = stubMeasuredLayout(40, 100);
    renderCell(<TableReferenceListCell references={TWO_PLAIN_REFERENCES} />);

    expect(labelOccurrences("REF-1")).toBe(2);
    expect(labelOccurrences("REF-2")).toBe(2);
    expect(screen.queryByText(OVERFLOW_PILL_PATTERN)).not.toBeInTheDocument();
  });

  it("drops the second chip once a withheld count forces the last slot to reserve room for the pill", () => {
    restoreLayout = stubMeasuredLayout(40, 100);
    renderCell(
      <TableReferenceListCell
        hiddenReferenceCount={1}
        references={TWO_PLAIN_REFERENCES}
      />
    );

    // REF-1 still fits (live chip + measurement clone); REF-2 lost its live
    // chip to the reserved pill width and survives only in the clone.
    expect(labelOccurrences("REF-1")).toBe(2);
    expect(labelOccurrences("REF-2")).toBe(1);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });
});

describe("TableReferenceListCell width overflow keeps hidden references reachable", () => {
  let restoreLayout: (() => void) | null = null;

  afterEach(() => {
    restoreLayout?.();
    restoreLayout = null;
  });

  it("renders each reference dropped for width with its own interaction arm in the tooltip", () => {
    restoreLayout = stubMeasuredLayout(40, 100);
    const onSelect = vi.fn();
    const navigation = createMemoryNavigation({ orgSlug: "example" });
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <TooltipProvider>
          <TableReferenceListCell
            references={[
              { href: "/example/refs/ref-1", id: "ref-1", label: "REF-1" },
              {
                href: "/example/refs/ref-2",
                id: "ref-2",
                label: "REF-2",
                tooltip: "Reference two",
              },
              {
                id: "ref-3",
                label: "REF-3",
                onSelect,
                tooltip: "Reference three",
              },
            ]}
          />
        </TooltipProvider>
      </NavigationProvider>
    );

    fireEvent.focus(screen.getByText("+2"));
    const tooltip = screen.getByRole("tooltip");
    const hiddenLink = within(tooltip).getByRole("link", {
      name: "Reference two",
    });
    expect(hiddenLink).toHaveAttribute("href", "/example/refs/ref-2");
    fireEvent.click(hiddenLink);
    expect(navigation.getCurrentHref()).toBe("/example/refs/ref-2");

    fireEvent.click(
      within(tooltip).getByRole("button", { name: "Reference three" })
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders hidden references as plain text when the cell is disabled", () => {
    restoreLayout = stubMeasuredLayout(40, 100);
    render(
      <TooltipProvider>
        <TableReferenceListCell
          disabled
          references={[
            { href: "/refs/ref-1", id: "ref-1", label: "REF-1" },
            {
              href: "/refs/ref-2",
              id: "ref-2",
              label: "REF-2",
              tooltip: "Reference two",
            },
            { href: "/refs/ref-3", id: "ref-3", label: "REF-3" },
          ]}
        />
      </TooltipProvider>
    );

    fireEvent.focus(screen.getByText("+2"));
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("Reference two")).toBeInTheDocument();
    expect(within(tooltip).queryByRole("link")).not.toBeInTheDocument();
  });
});
