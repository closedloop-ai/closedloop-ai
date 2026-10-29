import {
  type ChartConfig,
  ChartContainer,
  ChartLegendContent,
  ChartStyle,
  ChartTooltipContent,
  resolveTickFormatter,
  useChartLegendState,
} from "@closedloop-ai/design-system/components/ui/chart";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-10309. Recharts does not measure inside jsdom, so `ResponsiveContainer`
 * is stubbed to pass its child through (the same stub the donut suites use).
 * Everything under test stays real: the container's hidden-series state, both
 * legends, the tooltip body, and the config lookups they share. The Storybook
 * sweep clicks the interactive legend but never hovers a chart or double-clicks
 * a legend entry, so the tooltip variants, isolate, `resetKey`, the static
 * legend and most config lookups were unexercised.
 */

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

afterEach(cleanup);

const CONFIG: ChartConfig = {
  alpha: { label: "Alpha", color: "#111111" },
  beta: { label: "Beta", color: "#222222" },
};

const TEXTURE = { backgroundImage: "linear-gradient(red, blue)" };

function inChart(
  node: ReactNode,
  config: ChartConfig = CONFIG,
  resetKey?: string
) {
  return (
    <ChartContainer config={config} resetKey={resetKey}>
      <div>{node}</div>
    </ChartContainer>
  );
}

const PAYLOAD = [
  { dataKey: "alpha", name: "alpha", value: 1200, color: "#aaaaaa" },
  { dataKey: "beta", name: "beta", value: 5, color: "#bbbbbb" },
];

/**
 * The row wrapping a tooltip entry, found from its muted label span. The
 * header can carry the same text, so a bare text query is ambiguous.
 */
const rowOf = (label: string) =>
  (
    screen
      .getAllByText(label)
      .find((element) =>
        element.classList.contains("text-muted-foreground")
      ) as HTMLElement
  ).closest("div.w-full") as HTMLElement;

/** The tooltip's own root, found from any row inside it. */
const tooltipRootOf = (label: string) =>
  rowOf(label).parentElement?.parentElement as HTMLElement;

describe("useChart guard", () => {
  it("throws when a chart primitive renders outside a ChartContainer", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      expect(() =>
        render(<ChartTooltipContent active payload={PAYLOAD} />)
      ).toThrow("useChart must be used within a <ChartContainer />");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("ChartStyle", () => {
  it("renders nothing when no series carries a color or theme", () => {
    const { container } = render(
      <ChartStyle config={{ plain: { label: "Plain" } }} id="c1" />
    );

    expect(container.querySelector("style")).toBeNull();
  });

  it("writes one variable per colored series for each theme", () => {
    const { container } = render(
      <ChartStyle
        config={{
          flat: { color: "#123456" },
          themed: { theme: { light: "#aaaaaa", dark: "#bbbbbb" } },
          blank: { theme: { light: "", dark: "#cccccc" } },
          plain: { label: "Plain" },
        }}
        id="c1"
      />
    );
    const css = container.querySelector("style")?.innerHTML ?? "";
    const [light, dark] = css.split(".dark");

    expect(light).toContain("[data-chart=c1]");
    expect(light).toContain("--color-flat: #123456;");
    expect(light).toContain("--color-themed: #aaaaaa;");
    // An empty theme value with no fallback color emits no variable.
    expect(light).not.toContain("--color-blank");
    expect(dark).toContain("--color-flat: #123456;");
    expect(dark).toContain("--color-themed: #bbbbbb;");
    expect(dark).toContain("--color-blank: #cccccc;");
    expect(css).not.toContain("--color-plain");
  });

  it("is mounted by ChartContainer under the chart's own id", () => {
    const { container } = render(
      <ChartContainer config={CONFIG} id="revenue">
        <div />
      </ChartContainer>
    );

    expect(
      container.querySelector('[data-chart="chart-revenue"]')
    ).not.toBeNull();
    expect(container.querySelector("style")?.innerHTML).toContain(
      "[data-chart=chart-revenue]"
    );
  });
});

describe("ChartTooltipContent", () => {
  it("renders nothing while inactive or with an empty payload", () => {
    const { container } = render(
      inChart(
        <>
          <ChartTooltipContent active={false} payload={PAYLOAD} />
          <ChartTooltipContent active payload={[]} />
        </>
      )
    );

    expect(container.querySelector(".min-w-\\[8rem\\]")).toBeNull();
  });

  it("does not throw on a non-object payload entry while inactive", () => {
    expect(() =>
      render(inChart(<ChartTooltipContent active={false} payload={[null]} />))
    ).not.toThrow();
  });

  it("labels each row from the config and formats values with toLocaleString", () => {
    render(inChart(<ChartTooltipContent active hideLabel payload={PAYLOAD} />));

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText((1200).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("defaults the header to the first row's config label when no label is passed", () => {
    render(inChart(<ChartTooltipContent active payload={PAYLOAD} />));

    const header = tooltipRootOf("Alpha").firstElementChild;
    expect(header).toHaveTextContent("Alpha");
    expect(header).toHaveClass("font-medium");
  });

  it("uses the caller's valueFormatter and drops a null value", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          payload={[PAYLOAD[0], { ...PAYLOAD[1], value: null }]}
          valueFormatter={(value: number) => `$${value}`}
        />
      )
    );

    expect(screen.getByText("$1200")).toBeInTheDocument();
    expect(rowOf("Beta").querySelector(".font-mono")).toBeNull();
  });

  it("falls back to the item name when the config has no entry", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          payload={[{ dataKey: "gamma", name: "gamma", value: 3 }]}
        />
      )
    );

    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("skips payload entries typed none", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          payload={[PAYLOAD[0], { ...PAYLOAD[1], type: "none" }]}
        />
      )
    );

    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("resolves a string label through the config, or shows it verbatim", () => {
    const { rerender } = render(
      inChart(<ChartTooltipContent active label="beta" payload={PAYLOAD} />)
    );
    // "Beta" is both the resolved header and the second row's label.
    expect(screen.getAllByText("Beta")).toHaveLength(2);

    rerender(
      inChart(<ChartTooltipContent active label="Mar 3" payload={PAYLOAD} />)
    );
    expect(screen.getByText("Mar 3")).toHaveClass("font-medium");
  });

  it("takes the header from labelKey's config entry instead of the label", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          label="ignored"
          labelKey="beta"
          payload={[PAYLOAD[0]]}
        />
      )
    );

    expect(screen.queryByText("ignored")).toBeNull();
    expect(screen.getByText("Beta")).toHaveClass("font-medium");
  });

  it("renders no header when nothing resolves to a label", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          payload={[{ dataKey: "gamma", name: "gamma", value: 3 }]}
        />
      )
    );

    // The first child is the rows wrapper, not a header div.
    expect(tooltipRootOf("gamma").firstElementChild).toHaveClass(
      "grid",
      "gap-1.5"
    );
    expect(screen.getAllByText("gamma")).toHaveLength(1);
  });

  it("passes the resolved label and payload to labelFormatter", () => {
    const labelFormatter = vi.fn((value: ReactNode) => `On ${String(value)}`);
    render(
      inChart(
        <ChartTooltipContent
          active
          label="alpha"
          labelClassName="custom-label"
          labelFormatter={labelFormatter}
          payload={PAYLOAD}
        />
      )
    );

    expect(screen.getByText("On Alpha")).toHaveClass("custom-label");
    expect(labelFormatter).toHaveBeenCalledWith("Alpha", PAYLOAD);
  });

  it("hides the header when hideLabel is set", () => {
    render(
      inChart(
        <ChartTooltipContent active hideLabel label="Mar 3" payload={PAYLOAD} />
      )
    );

    expect(screen.queryByText("Mar 3")).toBeNull();
  });

  it("hands a row to the caller's formatter when it has a value and a name", () => {
    const formatter = vi.fn(() => <span>custom row</span>);
    render(
      inChart(
        <ChartTooltipContent
          active
          formatter={formatter}
          payload={[PAYLOAD[0], { dataKey: "beta", value: 2 }]}
        />
      )
    );

    expect(screen.getByText("custom row")).toBeInTheDocument();
    expect(formatter).toHaveBeenCalledExactlyOnceWith(
      1200,
      "alpha",
      PAYLOAD[0],
      0,
      undefined
    );
    // The nameless row falls back to the default layout and the config label.
    expect(rowOf("Beta")).toBeInTheDocument();
  });

  it.each([
    ["dot", "h-2.5"],
    ["line", "w-1"],
    ["dashed", "border-dashed"],
  ] as const)("draws a %s indicator", (indicator, expectedClass) => {
    render(
      inChart(
        <ChartTooltipContent
          active
          hideLabel
          indicator={indicator}
          payload={PAYLOAD}
        />
      )
    );

    expect(rowOf("Alpha").firstElementChild).toHaveClass(expectedClass);
  });

  it("nests the header inside a single non-dot row", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          indicator="dashed"
          label="Mar 3"
          payload={[PAYLOAD[0]]}
        />
      )
    );

    const row = rowOf("Alpha");
    expect(row).toContainElement(screen.getByText("Mar 3"));
    expect(row.firstElementChild).toHaveClass("my-0.5");
  });

  it("keeps the header above the rows for a single dot row", () => {
    render(
      inChart(
        <ChartTooltipContent active label="Mar 3" payload={[PAYLOAD[0]]} />
      )
    );

    expect(rowOf("Alpha")).not.toContainElement(screen.getByText("Mar 3"));
  });

  it("keeps the header above the rows when there are several non-dot rows", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          indicator="dashed"
          label="Mar 3"
          payload={PAYLOAD}
        />
      )
    );

    // Nesting is for a single row only; with two, the header is drawn once.
    expect(screen.getAllByText("Mar 3")).toHaveLength(1);
    expect(rowOf("Alpha")).not.toContainElement(screen.getByText("Mar 3"));
    expect(rowOf("Alpha").firstElementChild).not.toHaveClass("my-0.5");
  });

  it("colors the indicator from color, then the payload fill, then the item color", () => {
    const { rerender } = render(
      inChart(
        <ChartTooltipContent
          active
          color="#000000"
          hideLabel
          payload={PAYLOAD}
        />
      )
    );
    const bg = () =>
      (rowOf("Alpha").firstElementChild as HTMLElement).style.getPropertyValue(
        "--color-bg"
      );
    expect(bg()).toBe("#000000");

    rerender(
      inChart(
        <ChartTooltipContent
          active
          hideLabel
          payload={[{ ...PAYLOAD[0], payload: { fill: "#fefefe" } }]}
        />
      )
    );
    expect(bg()).toBe("#fefefe");

    rerender(
      inChart(<ChartTooltipContent active hideLabel payload={[PAYLOAD[0]]} />)
    );
    expect(bg()).toBe("#aaaaaa");
  });

  it("swaps a paint-server fill for the series' configured color and texture", () => {
    render(
      inChart(
        <ChartTooltipContent
          active
          hideLabel
          payload={[{ ...PAYLOAD[0], payload: { fill: "url(#tex-1)" } }]}
        />,
        { alpha: { label: "Alpha", color: "#111111", swatchTexture: TEXTURE } }
      )
    );

    const indicator = rowOf("Alpha").firstElementChild as HTMLElement;
    expect(indicator.style.getPropertyValue("--color-bg")).toBe("#111111");
    expect(indicator.style.backgroundImage).toBe("linear-gradient(red, blue)");
    expect(indicator).toHaveClass("h-3", "w-3");
  });

  it("renders the config icon instead of an indicator, and keeps the icon when the indicator is hidden", () => {
    const Icon = () => <svg data-testid="series-icon" />;
    const config: ChartConfig = { alpha: { label: "Alpha", icon: Icon } };
    const { rerender } = render(
      inChart(
        <ChartTooltipContent active hideLabel payload={[PAYLOAD[0]]} />,
        config
      )
    );
    expect(screen.getByTestId("series-icon")).toBeInTheDocument();
    expect(rowOf("Alpha").querySelector(".shrink-0")).toBeNull();

    // The icon branch is taken before `hideIndicator` is read, so a configured
    // icon survives it. The config has to stay on the rerender: dropping it
    // falls back to `CONFIG`, which has no icon, and the row would then be
    // empty for the wrong reason.
    rerender(
      inChart(
        <ChartTooltipContent
          active
          hideIndicator
          hideLabel
          payload={[PAYLOAD[0]]}
        />,
        config
      )
    );
    expect(screen.getByTestId("series-icon")).toBeInTheDocument();

    // With no icon configured, `hideIndicator` leaves the row with neither.
    rerender(
      inChart(
        <ChartTooltipContent
          active
          hideIndicator
          hideLabel
          payload={[PAYLOAD[0]]}
        />
      )
    );
    expect(screen.queryByTestId("series-icon")).toBeNull();
    expect(rowOf("Alpha").querySelector(".shrink-0")).toBeNull();
  });

  it("resolves the config entry through a nameKey field on the item or its payload", () => {
    const config: ChartConfig = {
      chrome: { label: "Chrome" },
      safari: { label: "Safari" },
    };
    // Recharts puts only its own fields (`dataKey`, `name`, `fill`, ...) on a
    // row and the chart's data row under `payload`, so the item-level lookup
    // is driven through `dataKey`, and the data-row lookup through `payload`.
    const { rerender } = render(
      inChart(
        <ChartTooltipContent
          active
          hideLabel
          nameKey="dataKey"
          payload={[{ dataKey: "chrome", name: "chrome-series", value: 1 }]}
        />,
        config
      )
    );
    expect(screen.getByText("Chrome")).toBeInTheDocument();

    rerender(
      inChart(
        <ChartTooltipContent
          active
          hideLabel
          nameKey="browser"
          payload={[{ dataKey: "b", value: 2, payload: { browser: "safari" } }]}
        />,
        config
      )
    );
    expect(screen.getByText("Safari")).toBeInTheDocument();
  });
});

const LEGEND_PAYLOAD = [
  { value: "alpha", dataKey: "alpha", color: "#aaaaaa" },
  { value: "beta", dataKey: "beta", color: "#bbbbbb" },
  { value: "gamma", dataKey: "gamma", color: "#cccccc" },
];

const pressed = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-pressed"))
    .map((button) => button.getAttribute("aria-pressed"));

describe("ChartLegendContent (interactive)", () => {
  it("renders nothing without a payload", () => {
    render(
      inChart(
        <div data-testid="legend-host">
          <ChartLegendContent />
        </div>
      )
    );

    expect(screen.getByTestId("legend-host")).toBeEmptyDOMElement();
  });

  it("labels entries from the config, falling back to the series identity", () => {
    render(inChart(<ChartLegendContent payload={LEGEND_PAYLOAD} />));

    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "gamma" })).toBeInTheDocument();
    expect(pressed()).toEqual(["true", "true", "true"]);
  });

  it("hides a series on click, offers Show all, and restores it", () => {
    render(inChart(<ChartLegendContent payload={LEGEND_PAYLOAD} />));
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(pressed()).toEqual(["true", "false", "true"]);
    const swatch = screen.getByRole("button", { name: "Beta" })
      .firstElementChild as HTMLElement;
    expect(swatch).toHaveClass("bg-transparent", "ring-1");
    expect(swatch.style.color).toBe("rgb(187, 187, 187)");

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(pressed()).toEqual(["true", "true", "true"]);

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(pressed()).toEqual(["true", "true", "true"]);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("refuses to hide the last visible series", () => {
    render(
      inChart(<ChartLegendContent payload={LEGEND_PAYLOAD.slice(0, 2)} />)
    );

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));

    expect(pressed()).toEqual(["false", "true"]);
  });

  it("isolates a series on double click, and restores all on a second double click", () => {
    render(inChart(<ChartLegendContent payload={LEGEND_PAYLOAD} />));

    fireEvent.doubleClick(screen.getByRole("button", { name: "Beta" }));
    expect(pressed()).toEqual(["false", "true", "false"]);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Beta" }));
    expect(pressed()).toEqual(["true", "true", "true"]);
  });

  it("isolates a different series when one is already isolated", () => {
    render(inChart(<ChartLegendContent payload={LEGEND_PAYLOAD} />));

    fireEvent.doubleClick(screen.getByRole("button", { name: "Beta" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Alpha" }));

    expect(pressed()).toEqual(["true", "false", "false"]);
  });

  it("does nothing on double click when there is only one series", () => {
    render(
      inChart(<ChartLegendContent payload={LEGEND_PAYLOAD.slice(0, 1)} />)
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "Alpha" }));

    expect(pressed()).toEqual(["true"]);
  });

  it("clears hidden series when resetKey changes", () => {
    const legend = <ChartLegendContent payload={LEGEND_PAYLOAD} />;
    const { rerender } = render(inChart(legend, CONFIG, "one"));
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));

    rerender(inChart(legend, CONFIG, "one"));
    expect(pressed()).toEqual(["true", "false", "true"]);

    rerender(inChart(legend, CONFIG, "two"));
    expect(pressed()).toEqual(["true", "true", "true"]);
  });

  it("toggles by the payload field named by seriesKey", () => {
    function HiddenProbe() {
      const { hiddenSeries } = useChartLegendState();
      return <output>{[...hiddenSeries].join(",")}</output>;
    }
    render(
      inChart(
        <>
          <ChartLegendContent
            payload={[
              { value: "a", dataKey: "value", payload: { key: "north" } },
              { value: "b", dataKey: "value", payload: { key: "south" } },
            ]}
            seriesKey="key"
          />
          <HiddenProbe />
        </>
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "south" }));

    expect(screen.getByRole("status")).toHaveTextContent("south");
  });

  it("hides a key the legend never registered", () => {
    function Toggler() {
      const { hiddenSeries, isSeriesHidden, toggleSeries } =
        useChartLegendState();
      return (
        <>
          <button onClick={() => toggleSeries("ghost")} type="button">
            hide ghost
          </button>
          <output>
            {`${hiddenSeries.size}:${String(isSeriesHidden("ghost"))}`}
          </output>
        </>
      );
    }
    render(inChart(<Toggler />));

    fireEvent.click(screen.getByRole("button", { name: "hide ghost" }));

    // No legend registered any keys, so the last-visible guard does not apply.
    expect(screen.getByRole("status")).toHaveTextContent("1:true");
  });

  it("renders the config icon unless hideIcon is set, and pads for the top position", () => {
    const Icon = () => <svg data-testid="legend-icon" />;
    const config: ChartConfig = { alpha: { label: "Alpha", icon: Icon } };
    const { container, rerender } = render(
      inChart(
        <ChartLegendContent
          payload={[LEGEND_PAYLOAD[0]]}
          verticalAlign="top"
        />,
        config
      )
    );
    expect(screen.getByTestId("legend-icon")).toBeInTheDocument();
    expect(container.querySelector(".pb-3")).not.toBeNull();

    rerender(
      inChart(
        <ChartLegendContent hideIcon payload={[LEGEND_PAYLOAD[0]]} />,
        config
      )
    );
    expect(screen.queryByTestId("legend-icon")).toBeNull();
    expect(container.querySelector(".pt-3")).not.toBeNull();
  });

  it("enlarges every swatch once any series is textured, and textures only that series", () => {
    render(
      inChart(<ChartLegendContent payload={LEGEND_PAYLOAD.slice(0, 2)} />, {
        alpha: { label: "Alpha", color: "#111111", swatchTexture: TEXTURE },
        beta: { label: "Beta", color: "#222222" },
      })
    );

    const swatchOf = (name: string) =>
      screen.getByRole("button", { name }).firstElementChild as HTMLElement;
    expect(swatchOf("Alpha")).toHaveClass("h-3", "w-3");
    expect(swatchOf("Beta")).toHaveClass("h-3", "w-3");
    expect(swatchOf("Alpha").style.backgroundImage).toBe(
      "linear-gradient(red, blue)"
    );
    expect(swatchOf("Beta").style.backgroundImage).toBe("");
  });
});

describe("ChartLegendContent (static)", () => {
  it("renders plain entries with no toggle semantics", () => {
    const { container } = render(
      inChart(
        <ChartLegendContent
          interactive={false}
          payload={LEGEND_PAYLOAD.slice(0, 2)}
          verticalAlign="top"
        />
      )
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(container.querySelector(".pb-3.gap-4")).not.toBeNull();
    const swatch = screen.getByText("Alpha")
      .previousElementSibling as HTMLElement;
    expect(swatch).toHaveClass("h-2", "w-2");
    expect(swatch.style.backgroundColor).toBe("rgb(170, 170, 170)");
  });

  it("falls back to the entry value and honors icons and hideIcon", () => {
    const Icon = () => <svg data-testid="static-icon" />;
    const config: ChartConfig = { alpha: { label: "Alpha", icon: Icon } };
    const { container, rerender } = render(
      inChart(
        <ChartLegendContent
          interactive={false}
          payload={[LEGEND_PAYLOAD[0], { value: "delta", color: "#dddddd" }]}
        />,
        config
      )
    );
    expect(screen.getByTestId("static-icon")).toBeInTheDocument();
    expect(screen.getByText("delta")).toBeInTheDocument();
    expect(container.querySelector(".pt-3.gap-4")).not.toBeNull();

    rerender(
      inChart(
        <ChartLegendContent
          hideIcon
          interactive={false}
          payload={[LEGEND_PAYLOAD[0]]}
        />,
        config
      )
    );
    expect(screen.queryByTestId("static-icon")).toBeNull();
  });
});

describe("resolveTickFormatter", () => {
  it("prefers the caller's formatter and coerces the tick to a number", () => {
    const format = resolveTickFormatter(
      (value) => `$${value.toFixed(1)}`,
      String
    );

    expect(format("3")).toBe("$3.0");
  });

  it("falls back to the chart's default formatter", () => {
    const format = resolveTickFormatter(undefined, (value) => `[${value}]`);

    expect(format(7)).toBe("[7]");
  });
});
