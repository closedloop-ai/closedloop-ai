import { SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

// FEA-4026: the styled DS tooltip renders its content through a Radix portal
// that never mounts in jsdom, so mock it to a transparent pass-through — the
// trigger keeps its role/classes and the content is inspectable inline.
vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

// A non-copyable property value only upgrades to the tooltip when it is
// genuinely clipped, detected via scrollWidth > clientWidth. jsdom reports both
// as 0, so we stub the geometry to force (or suppress) the truncated branch.
const originalScrollWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollWidth"
);
const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth"
);

function stubGeometry(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return scrollWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return clientWidth;
    },
  });
}

beforeEach(() => {
  // Wide content in a narrow column: the value overflows and truncates.
  stubGeometry(500, 100);
});

afterEach(() => {
  // scrollWidth/clientWidth are inherited from Element.prototype, so their own
  // descriptors on HTMLElement.prototype are normally undefined — restoring an
  // undefined descriptor would leave our stubs installed and leak the forced
  // geometry into later suites. Delete the own property in that case so the next
  // test gets jsdom's real (0) geometry back.
  if (originalScrollWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollWidth",
      originalScrollWidth
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
  }
  if (originalClientWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientWidth",
      originalClientWidth
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  }
});

// The Tokens row is the FEAT's headline example: a multi-part value that
// truncates and was previously unreadable. These counts produce the full
// rendered text asserted below.
const TOKENS_SESSION = createAgentSessionDetailFixture({
  tokensIn: 1_234_567,
  tokensOut: 890_123,
  cache: 456_789,
  cacheWrite: 234_567,
});
const TOKENS_FULL_VALUE =
  "1,234,567 in | 890,123 out | 456,789 cache read | 234,567 cache write";

// ISS-5820: the Cache Write row, now unconditional. Eight-digit counts are the
// longest string it can produce, so it is the row that actually clips.
const CACHE_WRITE_SESSION = createAgentSessionDetailFixture({
  tokenUsageByModel: [
    {
      cacheReadTokens: 902_000,
      cacheWrite1hTokens: 12_480_000,
      cacheWrite5mTokens: 48_360_000,
      cacheWriteTokens: 60_840_000,
      estimatedCostUsd: 4.82,
      inputTokens: 128_400,
      model: "claude-sonnet-4-5",
      outputTokens: 24_800,
    },
  ],
});
const CACHE_WRITE_FULL_VALUE = "48,360,000 (5m TTL) | 12,480,000 (1h TTL)";

// ISS-7737's Tokens sentence, pinned as an independent literal rather than
// imported from the module that declares it — the copy is the operator's, so an
// edit to it must surface here rather than be asserted against itself.
const TOKENS_POPULATION_NOTE =
  "Tokens counts all round-trips, including delegated work";

function renderDetail(session = TOKENS_SESSION, enabledFlags?: string[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    </AppCoreStoryProviders>
  );
}

async function openProperties() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Properties" }));
}

describe("session-detail property tooltips (FEA-4026)", () => {
  it("exposes the full truncated Tokens value via a keyboard-reachable tooltip", async () => {
    renderDetail();
    await openProperties();

    // Once clipped, the value's text span becomes a keyboard-focusable tooltip
    // trigger (tabIndex 0) — reachable by keyboard and assistive tech, not hover
    // alone. It is a focusable span, not a <button>, because opening the tooltip
    // is not an activation: a button would promise assistive tech an action that
    // does nothing. The full value stays in the DOM (only visually clipped), so
    // the trigger's accessible name is the complete value.
    // The rendered mono value disambiguates from the mocked tooltip-content div,
    // which also holds the full-value string.
    const trigger = screen
      .getByText(TOKENS_FULL_VALUE, { selector: ".mono" })
      .closest(".prd-prop-value-text");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("data-slot", "tooltip-trigger");
    expect(trigger).toHaveAttribute("tabindex", "0");
    expect(trigger?.tagName).toBe("SPAN");

    // … and the tooltip content repeats the full, untruncated value.
    const tooltips = screen.getAllByTestId("tooltip-content");
    expect(tooltips.some((el) => el.textContent === TOKENS_FULL_VALUE)).toBe(
      true
    );
  });

  it("keeps the clipped Cache Write split disclosed by its truncation tooltip", async () => {
    // ISS-5820 retired this row's gate ON, so it renders on packaged Desktop
    // too. It has no sentence to say — no counter is missing and no population
    // needs naming — so it stays on the TRUNCATION treatment: a focusable span
    // whose tooltip body is the FULL split and nothing else. Giving it an
    // `explanation` would swap the span trigger for a <button> and put a
    // sentence in front of the value it does not need.
    renderDetail(CACHE_WRITE_SESSION);
    await openProperties();

    // The disclosure itself, asserted first because it is the claim: the
    // tooltip body is the whole split — both TTL buckets and the separator —
    // not a sentence about it.
    const tooltips = screen.getAllByTestId("tooltip-content");
    expect(
      tooltips.some((el) => el.textContent === CACHE_WRITE_FULL_VALUE)
    ).toBe(true);

    const trigger = screen
      .getByText(CACHE_WRITE_FULL_VALUE, { selector: ".mono" })
      .closest(".prd-prop-value-text");
    expect(trigger).toHaveAttribute("data-slot", "tooltip-trigger");
    expect(trigger).toHaveAttribute("tabindex", "0");
    expect(trigger?.tagName).toBe("SPAN");
  });

  it("leaves a value that fits as a plain, non-focusable span with no tooltip", async () => {
    // Content narrower than its column does not overflow, so it stays ordinary
    // text: not focusable, not a tooltip trigger, no tooltip repeating
    // already-visible text.
    stubGeometry(40, 100);

    renderDetail();
    await openProperties();

    const textNode = screen
      .getByText(TOKENS_FULL_VALUE, { selector: ".mono" })
      .closest(".prd-prop-value-text");
    expect(textNode).toBeInTheDocument();
    expect(textNode).not.toHaveAttribute("tabindex");
    expect(textNode).not.toHaveAttribute("data-slot", "tooltip-trigger");
    // Copyable values always carry a tooltip, so scope to this value: no tooltip
    // repeats the (already fully visible) Tokens text.
    const tooltips = screen.queryAllByTestId("tooltip-content");
    expect(tooltips.some((el) => el.textContent === TOKENS_FULL_VALUE)).toBe(
      false
    );
  });

  /**
   * ISS-7737. The population sentence lands on the Tokens row through
   * `explanation`, which routes the value to `ExplainedPropertyValue` — the
   * treatment that used to REPLACE this file's whole subject. That would have
   * traded a disclosure for a disclosure: the reader gains the population and
   * loses everything past the ellipsis, on the longest value in the pane.
   *
   * The tooltip therefore leads with the full value and then says the sentence.
   * Asserted as ONE tooltip body carrying BOTH, not as two independent
   * `some(...)` checks, because the harm is precisely the sentence arriving
   * INSTEAD OF the value.
   */
  it("keeps the clipped Tokens value readable once the population sentence lands on it", async () => {
    renderDetail(TOKENS_SESSION, [
      SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
    ]);
    await openProperties();

    const tooltips = screen.getAllByTestId("tooltip-content");
    expect(
      tooltips.some(
        (el) =>
          el.textContent?.includes(TOKENS_FULL_VALUE) &&
          el.textContent.includes(TOKENS_POPULATION_NOTE)
      )
    ).toBe(true);
  });

  /**
   * ISS-7737 (visual QA): the value line is for the EYE only. Radix wires the
   * open tooltip as the trigger's `aria-describedby` and announces
   * `ariaLabel || children`, so without the label a screen reader reads the
   * whole token quadruple out of the description and then hears it a second time
   * from the trigger's own accessible name — which already carries it, since the
   * value is in the DOM and only visually clipped.
   */
  it("keeps the tooltip's announced description to the sentence alone", async () => {
    renderDetail(TOKENS_SESSION, [
      SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
    ]);
    await openProperties();

    // The Tokens row's explained value: the trigger whose own accessible name
    // already carries the quadruple AND the sentence, which is why the
    // description must not repeat the quadruple.
    const trigger = [
      ...document.querySelectorAll(".prd-prop-value-explained"),
    ].find((el) => el.textContent?.includes(TOKENS_FULL_VALUE));
    expect(trigger).toBeDefined();
    expect(trigger?.textContent).toContain(TOKENS_POPULATION_NOTE);

    const labelled = screen
      .getAllByTestId("tooltip-content")
      .filter((el) => el.textContent?.includes(TOKENS_POPULATION_NOTE));
    expect(labelled).toHaveLength(1);
    // Announced: the sentence. Rendered: the value, then the sentence.
    expect(labelled[0]).toHaveAttribute("aria-label", TOKENS_POPULATION_NOTE);
    expect(labelled[0]?.textContent).toContain(TOKENS_FULL_VALUE);
  });
});
