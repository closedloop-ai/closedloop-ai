import { MetricCard } from "@closedloop-ai/design-system/components/ui/primitives/metric-card";
import {
  MetricCardLane,
  MetricCardLaneList,
} from "@closedloop-ai/design-system/components/ui/primitives/metric-card-lane";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const LANES = (
  <MetricCardLaneList>
    <MetricCardLane label="API-billed" share="0.0%" value="$0" />
    <MetricCardLane
      label="Subscription-covered"
      share=">99.9%"
      value="$154,314"
    />
    <MetricCardLane label="Billing unknown" share="0.1%" value="$210" />
  </MetricCardLaneList>
);

describe("MetricCard lanes slot", () => {
  it("renders each lane's label, share and value", () => {
    render(
      <MetricCard label="Total estimated cost" lanes={LANES} value="$154,524" />
    );
    for (const [label, share, value] of [
      ["API-billed", "0.0%", "$0"],
      ["Subscription-covered", ">99.9%", "$154,314"],
      ["Billing unknown", "0.1%", "$210"],
    ]) {
      const term = screen.getByText(label);
      expect(term.tagName).toBe("DT");
      // Walk the lane's OWN cells. The list is one grid and every lane
      // contributes three siblings to it, so reading `parentElement.textContent`
      // would read every lane at once and pass on any figure in the card.
      expect(term.nextElementSibling?.textContent).toBe(share);
      expect(term.nextElementSibling?.nextElementSibling?.textContent).toBe(
        value
      );
    }
  });

  it("pairs each lane label with its own value, not a neighbour's", () => {
    render(
      <MetricCard label="Total estimated cost" lanes={LANES} value="$154,524" />
    );
    // The defect this guards is a lane row rendering the wrong figure beside a
    // label — which a whole-card text assertion cannot see, because every string
    // is present either way.
    const apiTerm = screen.getByText("API-billed");
    const apiValue = apiTerm.nextElementSibling?.nextElementSibling;
    expect(apiValue?.textContent).toBe("$0");
    expect(apiValue?.textContent).not.toBe("$154,314");
  });

  it("renders no lane region and no footer when the slot is absent", () => {
    // The slot is additive: every shipped consumer passes no `lanes`, so an
    // absent slot must leave the card exactly as it was — including NOT opening
    // a footer region that would change the card's padding and height.
    const { container } = render(
      <MetricCard label="Total estimated cost" value="$154,524" />
    );
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector('[data-slot="card-content"]')).toBeNull();
  });

  it("sizes the share and figure tracks on the list, not per row", () => {
    // whitlockk on #5932: a FIXED figure track clips — `value` is an arbitrary
    // ReactNode, so a long enough figure paints out of its track and over the
    // share beside it. Shared auto tracks size to the widest lane instead.
    const { container } = render(
      <MetricCard
        label="Total estimated cost"
        lanes={
          <MetricCardLaneList>
            <MetricCardLane label="Short" share="1.0%" value="$1" />
            <MetricCardLane
              label="Very long figure"
              share="99.0%"
              value="$1,234,567,890.12"
            />
          </MetricCardLaneList>
        }
        value="$1,234,567,891"
      />
    );
    const list = container.querySelector("dl");
    expect(list?.className).toContain("grid-cols-[minmax(0,1fr)_auto_auto]");
    // Six cells (two lanes x three) all resolve against that ONE track set.
    expect(list?.children.length).toBe(6);
  });

  it("opens the footer for lanes even with no detail, trend or delta", () => {
    const { container } = render(
      <MetricCard label="Total estimated cost" lanes={LANES} value="$154,524" />
    );
    // Without `lanes` in the `hasFooter` test the region would render at `pb-0`
    // and the lanes would sit flush against the card edge.
    expect(container.querySelector('[data-slot="card-content"]')).toBeTruthy();
  });

  // `muted` had no assertion in its OWN package: the only check on it lived in
  // `packages/app`, so the design system was free to change this tone and break
  // a test in another workspace while its own stayed green.
  it("recedes a muted lane's label while its figure keeps full weight", () => {
    render(
      <MetricCard
        label="Total estimated cost"
        lanes={
          <MetricCardLaneList>
            <MetricCardLane
              label="Subscription-covered"
              share="94.9%"
              value="$7,980"
            />
            <MetricCardLane
              label="Not subscription-covered"
              muted
              share="5.1%"
              value="$433"
            />
          </MetricCardLaneList>
        }
        value="$8,413"
      />
    );

    const plain = screen.getByText("Subscription-covered");
    const receded = screen.getByText("Not subscription-covered");
    expect(receded.className).not.toBe(plain.className);
    expect(receded.className).toContain("text-muted-foreground");
    // The LABEL only — a muted lane still states its amount at full weight, so
    // the figure track must be identical to its unmuted sibling's.
    const figureToneOf = (dt: HTMLElement) =>
      dt.nextElementSibling?.nextElementSibling?.className ?? "";
    expect(figureToneOf(receded)).toBe(figureToneOf(plain));
  });
});
