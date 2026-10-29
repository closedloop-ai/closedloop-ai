// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_SYNC_LEVEL_COPY } from "../../../shared/lib/data-sync-copy";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import { GUIDED_ONBOARDING_PHASES } from "../guided-onboarding-phase-registry";
import { GUIDED_ONBOARDING_STEP_SCROLL_CLASS } from "../guided-onboarding-step-layout";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

/**
 * The scroll class is assigned verbatim, so this locates the scrolling region.
 */
function exact(className: string): string {
  return `[class="${className}"]`;
}

function renderPhase(phase: keyof typeof GUIDED_ONBOARDING_PHASES) {
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onBack={vi.fn()}
      onComplete={vi.fn()}
      open
      phase={phase}
    />
  );
}

function stepFrame(): { actionRow: HTMLElement; scroll: HTMLElement } {
  const dialog = screen.getByRole("dialog");
  const scroll = dialog.querySelector<HTMLElement>(
    exact(GUIDED_ONBOARDING_STEP_SCROLL_CLASS)
  );
  // The final row owns Back/Continue; its gap may shrink when the account
  // step keeps Sign in and Skip beside it outside the scrolling region.
  const actionRow = scroll?.parentElement
    ?.lastElementChild as HTMLElement | null;
  if (!(scroll && actionRow)) {
    throw new Error("step rendered without a scroll region and an action row");
  }
  return { actionRow, scroll };
}

const PHASES = Object.keys(
  GUIDED_ONBOARDING_PHASES
) as (keyof typeof GUIDED_ONBOARDING_PHASES)[];

/** The two halves of the old overlay, as class tokens. */
const OUT_OF_FLOW = /\b(?:absolute|fixed|sticky)\b/;
const OPAQUE_SURFACE = /\bbg-/;

afterEach(() => {
  cleanup();
});

/**
 * ISS-10885: the action row used to be `absolute … bg-background` INSIDE the
 * step's scroll container, so at any scroll position but the last it painted an
 * opaque band of `--background` over whatever content sat behind it — on the
 * sync step, half of the third privacy card.
 *
 * jsdom resolves no Tailwind, so this pins the three structural facts that
 * make the overlap impossible rather than measuring pixels: the step's content
 * is INSIDE the region that scrolls, the row is outside it, and nothing from
 * the row up to (not including) the dialog card is taken out of flow or given
 * an opaque surface. Either one alone is not the contract — a
 * row taken out of flow still paints over content wherever it is parented, and
 * a static row parented inside the scroller scrolls away with it.
 */
describe("guided onboarding action row (ISS-10885)", () => {
  it.each(PHASES)(
    "keeps the %s step's action row out of the scrolling region",
    (phase) => {
      renderPhase(phase);
      const { actionRow, scroll } = stepFrame();

      expect(scroll.contains(actionRow)).toBe(false);
      expect(within(actionRow).getAllByRole("button").length).toBeGreaterThan(
        0
      );
      // The other half of reachability: a regression that empties the scroll
      // region and drops the step's body beside it passes everything above,
      // and that content is then clipped by the dialog's own `overflow-hidden`
      // with nothing to scroll it. Every phase owes the shell a focusable
      // heading, so the design system's own marker is what locates it.
      expect(scroll.querySelector('[data-slot="dialog-title"]')).not.toBeNull();
    }
  );

  it.each(PHASES)("leaves the %s step's action row in normal flow", (phase) => {
    renderPhase(phase);
    const dialog = screen.getByRole("dialog");
    const { actionRow } = stepFrame();

    // Walked up to (but not including) the dialog card rather than read off
    // the row itself: the row's
    // own class is the constant this file imports, so asserting on it alone
    // would re-check one string nine times and miss the shape ISS-10885
    // actually shipped moved one level up — a row that keeps the constant
    // inside an `absolute … bg-background` wrapper.
    const chain: string[] = [];
    for (
      let node: HTMLElement | null = actionRow;
      node && node !== dialog;
      node = node.parentElement
    ) {
      chain.push(node.className);
    }

    // The card itself is legitimately `fixed bg-background`; everything the
    // step draws inside it is not.
    expect(chain.length).toBeGreaterThan(1);
    for (const className of chain) {
      expect(className).not.toMatch(OUT_OF_FLOW);
      expect(className).not.toMatch(OPAQUE_SURFACE);
    }
  });

  it("puts the last privacy option inside the region that scrolls", () => {
    renderPhase(OnboardingPhase.SyncPolicy);
    const { actionRow, scroll } = stepFrame();

    // The row the operator's capture showed cut in half. Located through the
    // copy SSOT the card renders, so a reworded title cannot leave this
    // matching nothing and passing.
    const lastOption = screen.getByText(
      DATA_SYNC_LEVEL_COPY[DataSyncLevel.Full].title
    );

    expect(scroll.contains(lastOption)).toBe(true);
    expect(actionRow.contains(lastOption)).toBe(false);
  });
});
