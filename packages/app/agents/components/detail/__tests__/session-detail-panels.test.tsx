import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataPanel } from "../session-detail-panels";

// The styled sd3 tooltip renders through a Radix portal; mock it so the tooltip
// content is inspectable inline and the trigger keeps its truncate class.
vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

// MetadataValue only upgrades to the interactive tooltip when the text is
// genuinely clipped, which it detects via scrollWidth > clientWidth. jsdom
// reports both as 0, so we stub the geometry to force the truncated branch.
const originalScrollWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollWidth"
);
const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth"
);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return 500;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 100;
    },
  });
});

afterEach(() => {
  if (originalScrollWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollWidth",
      originalScrollWidth
    );
  }
  if (originalClientWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientWidth",
      originalClientWidth
    );
  }
});

const LONG_PATH =
  "/workspace/symphony-alpha/apps/app/app/(authenticated)/[orgSlug]/build";
const LONG_BRANCH =
  "bot/nightly-storyteller-steve-2026-06-13-some-very-long-descriptive-branch";

describe("SessionMetadataPanel (FEA-3644)", () => {
  it("truncates long metadata values and carries the full value in a tooltip", () => {
    render(
      <SessionMetadataPanel
        metadata={[{ label: "Working directory", value: LONG_PATH }]}
      />
    );

    const value = screen.getByText(LONG_PATH, {
      selector: '[data-slot="tooltip-trigger"]',
    });
    // Truncates within its column (no horizontal overflow) …
    expect(value).toHaveClass("truncate");
    expect(value).toHaveClass("min-w-0");
    // … and once clipped the trigger is keyboard-focusable so the full value is
    // reachable without a mouse.
    expect(value).toHaveAttribute("tabindex", "0");
    // … with the full value available on hover/focus via the styled tooltip.
    const tooltips = screen.getAllByTestId("tooltip-content");
    expect(tooltips.some((el) => el.textContent === LONG_PATH)).toBe(true);
  });

  it("truncates detail rows (branch/path) the same way", () => {
    render(
      <SessionMetadataPanel
        details={[{ label: "Branch", value: LONG_BRANCH }]}
        metadata={[]}
      />
    );

    const value = screen.getByText(LONG_BRANCH, {
      selector: '[data-slot="tooltip-trigger"]',
    });
    expect(value).toHaveClass("truncate");
    const tooltips = screen.getAllByTestId("tooltip-content");
    expect(tooltips.some((el) => el.textContent === LONG_BRANCH)).toBe(true);
  });

  it("leaves short (non-clipped) values as a plain, non-focusable span with no tooltip", () => {
    // Values that fit their column don't overflow …
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return 40;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 100;
      },
    });

    render(
      <SessionMetadataPanel
        metadata={[{ label: "Harness", value: "claude" }]}
      />
    );

    const value = screen.getByText("claude");
    // … so they stay ordinary text: no interactive trigger, no tabbable button,
    // no tooltip repeating text that's already fully visible.
    expect(value).not.toHaveAttribute("data-slot", "tooltip-trigger");
    expect(value).not.toHaveAttribute("tabindex");
    expect(screen.queryByTestId("tooltip-content")).not.toBeInTheDocument();
  });
});
