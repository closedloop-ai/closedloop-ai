import { MetricCard } from "@closedloop-ai/design-system/components/ui/primitives/metric-card";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9730: a NOT-COMPUTABLE metric card renders nothing at all — no card, no
 * glyph, no caption — instead of the muted "No data" slot.
 *
 * The whole risk of this change is that it swallows a state that is not
 * "not computable". Three of the four states must survive it, so each is
 * asserted here in BOTH gate positions: with the flag off (the shipped
 * treatment is untouched) and with it on (the hide does not reach them).
 *
 * The label is the probe rather than the "No data" copy: `valueUnavailableLabel`
 * is caller-overridable, so asserting on the copy would let a card that still
 * renders its whole frame under a different word pass as hidden.
 */
const LABEL = "LOC / $";
const DETAIL = "Cost coverage incomplete";

describe("MetricCard hideWhenUnavailable", () => {
  it("keeps the shipped no-data treatment when the gate is off", () => {
    render(<MetricCard detail={DETAIL} label={LABEL} value={null} />);
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.getByText(DETAIL)).toBeInTheDocument();
  });

  it("renders nothing for a not-computable value when the gate is on", () => {
    const { container } = render(
      <MetricCard
        detail={DETAIL}
        hideWhenUnavailable
        label={LABEL}
        value={null}
      />
    );
    // The card is GONE, not merely valueless: its label and its reason caption
    // must both be absent, and the subtree must be empty. Asserting only on
    // "No data" would stay green for a card that still rendered its frame.
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(DETAIL)).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("hides an explicitly-flagged unavailable value carrying a placeholder", () => {
    const { container } = render(
      <MetricCard
        hideWhenUnavailable
        label={LABEL}
        value="—"
        valueUnavailable
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders a hydrating card, so a row cannot shed and regrow cards", () => {
    render(
      <MetricCard
        detail="Importing your history"
        hideWhenUnavailable
        label={LABEL}
        loading
        value={null}
      />
    );
    // `loading` passes a nullish value too, so this is the case the naive
    // `noData` check would have hidden.
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText("Importing your history")).toBeInTheDocument();
  });

  it("still renders a FAILED read, because an error is not an absence", () => {
    render(
      <MetricCard
        detail="Unavailable"
        hideWhenUnavailable
        label={LABEL}
        muted
        value={null}
      />
    );
    // Hiding this would delete the reader's only signal that something broke.
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("renders a real zero, which is a fact about the population", () => {
    render(<MetricCard hideWhenUnavailable label={LABEL} value={0} />);
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders a real $0.00, which is not the same claim as 'not computed'", () => {
    render(<MetricCard hideWhenUnavailable label="Spend" value="$0.00" />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });
});
