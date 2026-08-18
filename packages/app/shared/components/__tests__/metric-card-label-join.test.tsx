import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import {
  METRIC_CARD_LABEL_JOIN_SLOT,
  METRIC_CARD_LABEL_TEXT_SLOT,
  MetricCard,
} from "@repo/design-system/components/ui/primitives/metric-card";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-5070 item 5, landed by ISS-5366 (stage review): the label→trigger NOWRAP
 * ISLAND.
 *
 * Wherever a host re-flows `MetricCard`'s label region to block flow — today only
 * `SummaryCardRow` — the info trigger is a trailing inline box, and a trailing
 * inline box has a band of card widths (205.8 to 224.8px) where the label TEXT
 * fits on one line but the trigger's ~19px advance does not fit after it. The
 * line breaker then dropped the glyph alone onto line two. Both shipped defaults
 * open inside that band: the desktop's 1400px window measures a 1099px track, so
 * five compact cards are 207px, and the web shell at 1440 measures ~1139 for
 * 215px cards.
 *
 * jsdom runs no layout engine, so nothing here can measure the break — that is
 * what the stories (`DenseLaunchTrack`, `DenseLabelTriggerOrphanBand`) render.
 * What IS checkable, and what actually regresses, is the STRUCTURE the fix
 * depends on. Three things have to hold together, and each fails silently on its
 * own:
 *
 *  1. the trigger sits inside the nowrap span, so the boundary the line breaker
 *     would break at has that span as its nearest common ancestor;
 *  2. the label text sits inside its OWN `white-space: normal` span, so the label
 *     still wraps between its own words rather than running out of the card; and
 *  3. the strip flips both spans to `inline`, because `display: contents`
 *     generates no box and a nowrap island with no box suppresses nothing.
 *
 * Drop any one and the strip renders exactly as it did before the fix, with every
 * other test still green.
 */

const WRAPPING_LABEL = "cost";
const ONE_LINE_LABEL = "Sessions";
const INFO = { what: "Spend not covered by a Claude subscription." };

function joinSlot(): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-slot="${METRIC_CARD_LABEL_JOIN_SLOT}"]`
  );
  if (!node) {
    throw new Error("MetricCard rendered no label-join slot");
  }
  return node;
}

function textSlot(): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-slot="${METRIC_CARD_LABEL_TEXT_SLOT}"]`
  );
  if (!node) {
    throw new Error("MetricCard rendered no label-text slot");
  }
  return node;
}

describe("MetricCard label/trigger nowrap island (ISS-5070 item 5)", () => {
  it("puts the label and the trigger in one nowrap unit, with the label wrapping inside it", () => {
    render(<MetricCard info={INFO} label={WRAPPING_LABEL} value="$19,608" />);

    const join = joinSlot();
    const text = textSlot();
    const trigger = screen.getByRole("button", {
      name: `About ${WRAPPING_LABEL}`,
    });

    // (1) The OUTER span carries the nowrap and contains BOTH halves, so the
    // soft-wrap opportunity between the label's last character and the trigger
    // has it as their nearest common ancestor and is suppressed.
    expect(join.className).toContain("whitespace-nowrap");
    expect(join).toContainElement(text);
    expect(join).toContainElement(trigger);

    // (2) The INNER span restores normal wrapping over the label text ONLY. If
    // the trigger ever moved inside it, the boundary's nearest common ancestor
    // would be `white-space: normal` again and the orphan would silently return
    // — which is exactly the regression this asserts against.
    expect(text.className).toContain("whitespace-normal");
    expect(text).not.toContainElement(trigger);

    // The trigger is a DIRECT child of the join span, which is what lets the
    // strip's `[data-slot=…join]>button` rules (the 6px separation and
    // `align-top`) reach it at all.
    expect(trigger.parentElement).toBe(join);
  });

  it("keeps the label a single text node so text queries still match it", () => {
    // The alternative fix — slicing `label` into head + last word — would have
    // split "cost" across two elements and broken every
    // `getByText`/`textContent` assertion in `packages/app`, `apps/desktop` and
    // the Playwright specs for a purely visual change. Pinned so a later
    // "simplification" to a head/tail slice fails here first.
    render(<MetricCard info={INFO} label={WRAPPING_LABEL} value="$19,608" />);

    expect(screen.getByText(WRAPPING_LABEL)).toBe(textSlot());
  });

  it("is inert for a consumer that keeps the flex label row", () => {
    // The Insights KPI tiles, the Dashboard and Branches leave the region as
    // `MetricCard`'s own flex row, where the trigger is a flex item on a single
    // non-wrapping line and CANNOT orphan. `display: contents` generates no box,
    // so both spans dissolve there and those hosts keep the exact box tree they
    // had: one anonymous text item and the trigger, 6px apart. That is what keeps
    // this ISS-5070 item 5 and not item 6, which moves the glyph for every
    // consumer and still needs its own visual pass against those tiles.
    render(
      <MetricCard
        className="h-full"
        info={INFO}
        label={WRAPPING_LABEL}
        value="$19,608"
      />
    );

    expect(joinSlot().className).toContain("contents");
    expect(textSlot().className).toContain("contents");
    const region = textSlot().closest('[data-slot="card-description"]');
    expect(region?.className).toContain("flex");
    expect(region?.className).toContain("gap-1.5");
  });

  it("renders no island at all for a card without an info trigger", () => {
    render(<MetricCard label={ONE_LINE_LABEL} value="1,284" />);

    expect(
      document.querySelector(`[data-slot="${METRIC_CARD_LABEL_JOIN_SLOT}"]`)
    ).toBeNull();
    expect(screen.getByText(ONE_LINE_LABEL)).toBeInTheDocument();
  });

  it("is opted into by the strip, which flips both spans to inline", () => {
    // (3) The island only becomes real where a host gives it boxes. The strip is
    // the one caller that re-flows the region to block flow, so it is the one
    // caller that has an orphan to close — and it opts in by flipping both slots.
    render(
      <SummaryCardRow>
        <MetricCard info={INFO} label={WRAPPING_LABEL} value="$19,608" />
      </SummaryCardRow>
    );

    const row = textSlot().closest('[data-slot="card"]')?.parentElement;
    expect(row).toBeTruthy();
    const className = row?.className ?? "";
    expect(className).toContain("[&_[data-slot=card-description]]:block");
    expect(className).toContain(
      `[&_[data-slot=${METRIC_CARD_LABEL_JOIN_SLOT}]]:inline`
    );
    expect(className).toContain(
      `[&_[data-slot=${METRIC_CARD_LABEL_TEXT_SLOT}]]:inline`
    );
    // The trigger's own two rules follow it onto the join slot. `ml-0` leaves
    // `InfoHint`'s `px-1.5` uncancelled for the same 6px the flex `gap-1.5` used
    // to supply (NOT `ml-1.5`, which stacks 6 on 6), and `align-top` keeps the
    // trigger's 16px margin box inside the label's `leading-4` line box instead
    // of growing the region past its 32px reservation.
    expect(className).toContain(
      `[&_[data-slot=${METRIC_CARD_LABEL_JOIN_SLOT}]>button]:ml-0`
    );
    expect(className).toContain(
      `[&_[data-slot=${METRIC_CARD_LABEL_JOIN_SLOT}]>button]:align-top`
    );
  });
});
