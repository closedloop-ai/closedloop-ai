import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BotIcon,
  HammerIcon,
  LayersIcon,
  PlugIcon,
  TerminalIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentsTypeTabOption,
  AgentsTypeTabStrip,
} from "../agents-type-tab-strip";

/**
 * ISS-4803: the strip's overflow disclosure.
 *
 * The defect is a LAYOUT one, and jsdom has no layout — every element is
 * "visible" and nothing is ever clipped — so a test that renders the strip
 * narrow and then clicks a trailing tab proves nothing at all: it passes
 * identically against the broken build, where that tab is present in the DOM
 * and merely scrolled off screen where no user can reach it.
 *
 * What these tests assert instead is the thing the fix actually adds: at a
 * measured narrow width the strip STOPS rendering the tabs it cannot fit, and
 * puts them behind a named, keyboard-operable control that can activate them.
 * That control does not exist without the fix, so every assertion below fails
 * when the production change is reverted.
 */

// The real strip vocabulary, in KIND_ORDER, with the icons `kindMeta` supplies.
const STRIP_OPTIONS: readonly AgentsTypeTabOption[] = [
  { value: "all", label: "All", icon: LayersIcon },
  { value: "agent", label: "Agents", icon: BotIcon },
  { value: "command", label: "Commands", icon: TerminalIcon },
  { value: "skill", label: "Skills", icon: HammerIcon },
  { value: "plugin", label: "Plugins", icon: LayersIcon },
  { value: "mcp", label: "MCPs", icon: PlugIcon },
  { value: "tool", label: "Tools", icon: WrenchIcon },
  { value: "hook", label: "Hooks", icon: WebhookIcon },
];

// The reported viewport (ISS-4803 evidence, `a-web-list-mobile.png`) minus the
// row's `px-4` gutters — the CONTENT width `useContainerWidth` reports.
const NARROW_ROW_CONTENT_WIDTH_PX = 358;
const WIDE_ROW_CONTENT_WIDTH_PX = 1200;

const RE_HOOKS = /^Hooks$/;
const RE_ALL = /^All$/;
// The overflow control names what it hides rather than announcing a bare count.
const RE_OVERFLOW_BUTTON = /^\d+ more component types: /;

// How many ArrowDown presses the keyboard walk is allowed before giving up —
// bounded so a broken menu fails the assertion instead of hanging the suite.
const MAX_MENU_ARROW_STEPS = 12;

/**
 * Replaces the shared jsdom `ResizeObserver` shim (which reports a fixed 800px)
 * with one reporting `widthPx`, so `useContainerWidth` measures the row width
 * this test is about. jsdom never lays anything out, so the observer is the only
 * source of a real measurement.
 */
function stubObservedWidth(widthPx: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        const size: ResizeObserverSize = {
          inlineSize: widthPx,
          blockSize: 40,
        };
        this.callback(
          [
            {
              target,
              contentRect: new DOMRect(0, 0, widthPx, 40),
              borderBoxSize: [size],
              contentBoxSize: [size],
              devicePixelContentBoxSize: [size],
            },
          ],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {
        // no-op
      }
      disconnect() {
        // no-op
      }
    }
  );
}

function renderStrip({
  overflowMenuEnabled,
  value = "all",
  onValueChange = vi.fn(),
}: {
  overflowMenuEnabled: boolean;
  value?: string;
  onValueChange?: (next: string) => void;
}) {
  return {
    onValueChange,
    ...render(
      <AgentsTypeTabStrip
        onValueChange={onValueChange}
        options={STRIP_OPTIONS}
        overflowMenuEnabled={overflowMenuEnabled}
        value={value}
      />
    ),
  };
}

describe("AgentsTypeTabStrip overflow disclosure (ISS-4803)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("at a phone row width", () => {
    beforeEach(() => {
      stubObservedWidth(NARROW_ROW_CONTENT_WIDTH_PX);
    });

    it("renders every tab on the strip and no overflow control while the flag is off", () => {
      renderStrip({ overflowMenuEnabled: false });

      expect(screen.getAllByRole("radio")).toHaveLength(STRIP_OPTIONS.length);
      expect(
        screen.queryByRole("button", { name: RE_OVERFLOW_BUTTON })
      ).not.toBeInTheDocument();
    });

    it("drops the tabs it cannot fit and names them on the overflow control", () => {
      renderStrip({ overflowMenuEnabled: true });

      const onStrip = screen.getAllByRole("radio");
      expect(onStrip.length).toBeLessThan(STRIP_OPTIONS.length);

      const overflowButton = screen.getByRole("button", {
        name: RE_OVERFLOW_BUTTON,
      });
      // The accessible name is the affordance: a screen-reader user learns what
      // is hidden without having to open anything. Every tab missing from the
      // strip has to be in it, or the control is lying about what it holds.
      const stripLabels = new Set(
        onStrip.map((tab) => tab.getAttribute("aria-label"))
      );
      const hiddenLabels = STRIP_OPTIONS.filter(
        (option) => !stripLabels.has(option.label)
      ).map((option) => option.label);
      const accessibleName = overflowButton.getAttribute("aria-label") ?? "";

      expect(hiddenLabels.length).toBeGreaterThan(0);
      for (const label of hiddenLabels) {
        expect(accessibleName).toContain(label);
      }
      expect(accessibleName).toContain(`${hiddenLabels.length} more`);
    });

    it("activates a tab that is not on the strip, through the overflow menu", async () => {
      const user = userEvent.setup();
      const { onValueChange } = renderStrip({ overflowMenuEnabled: true });

      // Hooks is last in KIND_ORDER, so at this width it is off the strip.
      expect(
        screen.queryByRole("radio", { name: RE_HOOKS })
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: RE_OVERFLOW_BUTTON })
      );
      await user.click(await screen.findByRole("menuitem", { name: RE_HOOKS }));

      expect(onValueChange).toHaveBeenCalledWith("hook");
    });

    it("reaches and operates the overflow control by keyboard alone", async () => {
      const user = userEvent.setup();
      const { onValueChange } = renderStrip({ overflowMenuEnabled: true });

      // The strip is a Radix ToggleGroup — roving tabindex, so the whole
      // segmented control is ONE tab stop. The overflow control is the next
      // one, which is what makes the hidden kinds reachable without a pointer.
      await user.tab();
      await user.tab();
      const overflowButton = screen.getByRole("button", {
        name: RE_OVERFLOW_BUTTON,
      });
      expect(overflowButton).toHaveFocus();

      await user.keyboard("{Enter}");
      const hooksItem = await screen.findByRole("menuitem", { name: RE_HOOKS });
      for (
        let step = 0;
        step < MAX_MENU_ARROW_STEPS && document.activeElement !== hooksItem;
        step += 1
      ) {
        await user.keyboard("{ArrowDown}");
      }
      expect(hooksItem).toHaveFocus();

      await user.keyboard("{Enter}");
      expect(onValueChange).toHaveBeenCalledWith("hook");
    });

    it("keeps the selected tab on the strip even when it would not fit", () => {
      // The selected segment is the only thing saying what the catalog below is
      // filtered to. Letting it fall into the menu would leave every visible
      // segment unselected, which reads as "All" — the UI lying about state.
      renderStrip({ overflowMenuEnabled: true, value: "hook" });

      // Anchored to the COLLAPSED state: without the fit the strip renders
      // everything and this would assert nothing about the pinning.
      expect(
        screen.getByRole("button", { name: RE_OVERFLOW_BUTTON })
      ).toBeInTheDocument();
      const hooksTab = screen.getByRole("radio", { name: RE_HOOKS });
      expect(hooksTab).toHaveAttribute("aria-checked", "true");
      // ...and the always-reachable All segment is not what got displaced.
      expect(screen.getByRole("radio", { name: RE_ALL })).toBeInTheDocument();
      // Nothing in the menu is ever the selected tab, so no menu item claims it.
      expect(
        screen.queryByRole("menuitem", { name: RE_HOOKS })
      ).not.toBeInTheDocument();
    });
  });

  describe("at a desktop row width", () => {
    beforeEach(() => {
      stubObservedWidth(WIDE_ROW_CONTENT_WIDTH_PX);
    });

    it("keeps the whole strip expanded with no overflow control", () => {
      renderStrip({ overflowMenuEnabled: true });

      expect(screen.getAllByRole("radio")).toHaveLength(STRIP_OPTIONS.length);
      expect(
        screen.queryByRole("button", { name: RE_OVERFLOW_BUTTON })
      ).not.toBeInTheDocument();
    });
  });

  describe("before the row has been measured", () => {
    it("renders every tab rather than collapsing on a guess", () => {
      // No ResizeObserver at all: `useContainerWidth` reports its wide default
      // with `measured: false`, which must degrade to today's behavior (the
      // full strip inside the scrolling track) rather than hide tabs that fit.
      vi.stubGlobal("ResizeObserver", undefined);

      renderStrip({ overflowMenuEnabled: true });

      expect(screen.getAllByRole("radio")).toHaveLength(STRIP_OPTIONS.length);
      expect(
        screen.queryByRole("button", { name: RE_OVERFLOW_BUTTON })
      ).not.toBeInTheDocument();
    });
  });
});
