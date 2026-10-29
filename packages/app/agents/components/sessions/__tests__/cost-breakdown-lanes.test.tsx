import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  buildCostBreakdownLanes,
  COST_BREAKDOWN_DISCLOSURE_LABEL,
} from "../cost-breakdown-lanes";
import { SESSIONS_COST_BREAKDOWN_DISCLOSURE_LABEL } from "../cost-metric-card";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";

function usage(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalEstimatedCost: 150,
      subscriptionEstimatedCost: 50,
      apiEstimatedCost: 100,
      meteredEstimatedCost: 40,
      unknownEstimatedCost: 60,
      ...overrides,
    }
  );
}

/**
 * Render the card's lane slot and open the disclosure the lanes live behind.
 *
 * Every lane assertion goes through the real trigger rather than reaching into
 * the returned tree, because the popover mounts its content lazily: querying
 * without opening would assert against an empty DOM and pass for the wrong
 * reason.
 */
async function openLanes(
  overrides: Partial<AgentSessionUsageSummary> = {}
): Promise<void> {
  const user = userEvent.setup();
  render(buildCostBreakdownLanes(usage(overrides)));
  await user.click(
    screen.getByRole("button", { name: COST_BREAKDOWN_DISCLOSURE_LABEL })
  );
}

/** The three lane labels, in the order the card renders them. */
const LANE_LABELS = [
  "API-billed",
  "Subscription-covered",
  "Billing unknown",
] as const;

/** The clamp markers a rendered share may carry, for parsing it back. */
const SHARE_DECORATION = /[<>%]/g;

/** Every lane's rendered value, as displayed, in DOM order. */
function renderedValues(): (string | undefined)[] {
  return LANE_LABELS.map(
    (label) =>
      screen.getByText(label).nextElementSibling?.nextElementSibling
        ?.textContent
  );
}

/** Every lane's rendered share, as a number, in DOM order. */
function renderedShares(): number[] {
  return LANE_LABELS.map((label) => {
    const text = screen.getByText(label).nextElementSibling?.textContent ?? "";
    return Number.parseFloat(text.replace(SHARE_DECORATION, ""));
  });
}

describe("buildCostBreakdownLanes", () => {
  it("states each lane's figure and share against the total", async () => {
    await openLanes();

    const api = screen.getByText("API-billed");
    expect(api.nextElementSibling?.textContent).toBe("26.7%");
    expect(api.nextElementSibling?.nextElementSibling?.textContent).toBe("$40");
  });

  // whitlockk on #5953: the allocator shifts a lane so the whole-dollar column sums
  // to the headline. Grading that SHIFTED figure against the total let a share
  // read 140% and the column total 200%. Shares describe the payload's true
  // proportions, which no display rounding may move.
  it("never lets the lane shares exceed 100% in total", async () => {
    await openLanes({
      totalEstimatedCost: 1,
      meteredEstimatedCost: 0.4,
      subscriptionEstimatedCost: 0.4,
      apiEstimatedCost: 0.6,
      unknownEstimatedCost: 0.2,
    });

    const total = renderedShares().reduce((sum, share) => sum + share, 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  // The same payload, on the value side: absorbing a $1 remainder into a $0.40
  // lane is a 250% distortion, not the rounding-scale nudge the allocator
  // assumes. Sub-dollar lanes are not whole-dollar quantities, so each renders
  // its own true value and the column simply does not reconcile — which is the
  // honest outcome rather than a manufactured one.
  it("does not rewrite a sub-dollar lane to make the column reconcile", async () => {
    await openLanes({
      totalEstimatedCost: 1,
      meteredEstimatedCost: 0.4,
      subscriptionEstimatedCost: 0.4,
      apiEstimatedCost: 0.6,
      unknownEstimatedCost: 0.2,
    });

    const api = screen.getByText("API-billed");
    expect(api.nextElementSibling?.nextElementSibling?.textContent).toBe(
      "$0.40"
    );
  });

  // The other end of the same shift. The guard above catches a lane that STARTS
  // under a dollar; this one starts at $1.40 and the -1 remainder would land it
  // at $0.40 — the largest share, 58.3%, rendering the smallest figure on the
  // card, under a `$2` headline the column then misses by 40 cents.
  it("does not rewrite a whole-dollar lane down below a dollar", async () => {
    await openLanes({
      totalEstimatedCost: 2.4,
      meteredEstimatedCost: 1.4,
      subscriptionEstimatedCost: 0.5,
      apiEstimatedCost: 1.9,
      unknownEstimatedCost: 0.5,
    });

    const api = screen.getByText("API-billed");
    // Its own value, rounded — NOT the $0.40 the allocator would have written,
    // which is the specific regression: a lane rendering a figure that is not
    // its own, and the largest share carrying the smallest number on the card.
    const value = api.nextElementSibling?.nextElementSibling?.textContent;
    expect(value).not.toBe("$0.40");
    expect(value).toBe("$1");
    expect(api.nextElementSibling?.textContent).toBe("58.3%");
  });

  // The allocator still earns its keep where it was designed to: whole-dollar
  // lanes, where +/-$1 IS rounding-scale.
  it("absorbs whole-dollar rounding into the largest lane so the column sums", async () => {
    await openLanes({
      totalEstimatedCost: 48_920.5,
      meteredEstimatedCost: 16_825.4,
      subscriptionEstimatedCost: 31_004.18,
      apiEstimatedCost: 17_916.32,
      unknownEstimatedCost: 1090.92,
    });

    // Headline rounds to 48,921; the lanes round to 48,920, so the largest lane
    // takes the remaining dollar.
    expect(
      screen.getByText("Subscription-covered").nextElementSibling
        ?.nextElementSibling?.textContent
    ).toBe("$31,005");
  });

  // The share basis, made observable. On a small total the allocator's $1 shift
  // moves the largest lane's share by a visible point, so grading the SHIFTED
  // figure instead of the payload's own would render 51.4% for a lane that is
  // truly 50.4% of the total.
  it("grades each share on the payload's figure, not the allocated one", async () => {
    await openLanes({
      totalEstimatedCost: 100,
      meteredEstimatedCost: 50.4,
      subscriptionEstimatedCost: 30.3,
      apiEstimatedCost: 69.7,
      unknownEstimatedCost: 19.3,
    });

    const api = screen.getByText("API-billed");
    // The VALUE carries the allocated dollar so the column reconciles...
    expect(api.nextElementSibling?.nextElementSibling?.textContent).toBe("$51");
    // ...while the SHARE stays the payload's own proportion.
    expect(api.nextElementSibling?.textContent).toBe("50.4%");
  });

  // The payload the allocator's own docstring names, which nothing sent. Three
  // $0.50 lanes under a $1.50 total round to 1+1+1 against a headline of 2, so
  // the -1 remainder would drive the absorbing lane to -$0.50: a negative
  // figure under a positive total, on the card written to stop the UI lying
  // about money. The $2.40 case above reaches the same guard with a POSITIVE
  // `absorbed`; this is the only fixture that drives it negative.
  it("never renders a negative lane figure when the remainder is -1", async () => {
    await openLanes({
      totalEstimatedCost: 1.5,
      meteredEstimatedCost: 0.5,
      subscriptionEstimatedCost: 0.5,
      apiEstimatedCost: 1,
      unknownEstimatedCost: 0.5,
    });

    // Each lane renders its own figure, rounded — so the column reads $3
    // under a $2 headline and simply does not reconcile, which is the honest
    // outcome for a sub-dollar payload. What it must never do is go negative.
    expect(renderedValues()).toEqual(["$1", "$1", "$1"]);
  });

  // A lane at ~0.04% of the total must not round to `0.0%` — that reads as
  // zero, not near-zero. The lower clamp catches it and renders `<0.1%`.
  it("clamps a near-zero share to <0.1% instead of rounding to 0.0%", async () => {
    await openLanes({
      totalEstimatedCost: 10_000,
      meteredEstimatedCost: 4,
      subscriptionEstimatedCost: 6000,
      apiEstimatedCost: 4000,
      unknownEstimatedCost: 3996,
    });

    const api = screen.getByText("API-billed");
    expect(api.nextElementSibling?.textContent).toBe("<0.1%");
  });

  // A lane at ~99.95% of the total must not round to `100.0%` — that reads as
  // the whole total, which it is not. The upper clamp renders `>99.9%`.
  it("clamps a near-total share to >99.9% instead of rounding to 100.0%", async () => {
    await openLanes({
      totalEstimatedCost: 10_000,
      meteredEstimatedCost: 9995,
      subscriptionEstimatedCost: 3,
      apiEstimatedCost: 9997,
      unknownEstimatedCost: 2,
    });

    const api = screen.getByText("API-billed");
    expect(api.nextElementSibling?.textContent).toBe(">99.9%");
  });

  // Operator decision, 2026-08-26: all three lanes read equally. "Billing
  // unknown" carried the muted label as a "this is a disclosure, not spend"
  // signal, but on a subscription-heavy account it is the WHOLE
  // non-subscription bucket — receding the one lane that says "we could not
  // determine this" is a softer version of the hiding this card exists to undo.
  // Pinned so it cannot drift back silently; nothing asserted it either way
  // before.
  it("gives every lane label the same weight, including Billing unknown", async () => {
    await openLanes();

    const tone = (label: string) =>
      screen.getAllByText(label)[0]?.className ?? "";
    expect(tone("Billing unknown")).toContain("text-foreground");
    expect(tone("Billing unknown")).not.toContain("text-muted-foreground");
    expect(tone("Billing unknown")).toBe(tone("API-billed"));
  });

  it("renders nothing when the payload cannot be split", () => {
    const { container } = render(
      buildCostBreakdownLanes(usage({ meteredEstimatedCost: undefined }))
    );

    expect(container.querySelector("dl")).toBeNull();
  });
});

describe("the Cost breakdown disclosure (ISS-8157)", () => {
  // The lanes sit behind the disclosure at EVERY width (operator decision,
  // 2026-08-26). A lane label beside two right-aligned numbers needs roughly
  // 300px, which the Sessions strip does not give it at the widths people
  // actually use; an earlier revision kept a second inline copy for the widths
  // that do, and product retired it rather than ship a card whose shape depends
  // on the reader's monitor.
  it("names the disclosure trigger in product's sentence case", async () => {
    await openLanes();

    const trigger = screen.getByRole("button", {
      name: COST_BREAKDOWN_DISCLOSURE_LABEL,
    });
    expect(trigger).toBeTruthy();
    expect(COST_BREAKDOWN_DISCLOSURE_LABEL).toBe("Cost breakdown");
  });

  it("gives the trigger a real hit target, not a bare glyph line", async () => {
    await openLanes();

    // The prototype's first pass measured 18.5px; `h-6` is the 24px target the
    // sibling InfoHint already takes.
    const trigger = screen.getByRole("button", {
      name: COST_BREAKDOWN_DISCLOSURE_LABEL,
    });
    expect(trigger.className).toContain("h-6");
  });

  it("names the popover for a screen reader, not just visually", async () => {
    await openLanes();

    // Radix gives the content `role="dialog"`. Without the heading wired to it
    // the overlay announces as an unnamed dialog, so the accessible NAME is the
    // assertion — not the mere presence of the heading text, which would stay
    // green with the association removed.
    expect(
      screen.getByRole("dialog", {
        name: SESSIONS_COST_BREAKDOWN_DISCLOSURE_LABEL,
      })
    ).toBeTruthy();
  });

  it("reveals the three lanes only once the disclosure is opened", async () => {
    const user = userEvent.setup();
    render(buildCostBreakdownLanes(usage()));

    // Closed: no lane in the DOM at all. The popover mounts its content lazily
    // and there is no second, inline copy any more, so this is a real absence
    // rather than a hidden branch.
    expect(screen.queryAllByText("API-billed")).toHaveLength(0);

    await user.click(
      screen.getByRole("button", { name: COST_BREAKDOWN_DISCLOSURE_LABEL })
    );

    // Open: exactly one copy of each lane. A second would mean the retired
    // inline branch had come back and the card was stating its figures twice.
    for (const label of [
      "API-billed",
      "Subscription-covered",
      "Billing unknown",
    ]) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
  });
});
