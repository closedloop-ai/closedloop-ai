import type { SearchHit } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SidebarContent } from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8777 — the search combobox popup must not be clipped by the sidebar's
 * scroll region once ISS-8759 moves `<Search />` down into the Labs section.
 *
 * The containment is built here from the SAME production primitives that move
 * produces — the real `SidebarContent` (which is what carries `overflow-auto`)
 * wrapping the real `SidebarCollapsibleSection` — rather than from a stand-in
 * div, so the ancestor chain under test is the shipped one. It is reconstructed
 * here because the `<Search />` adapter that places it in the sidebar lives in
 * `apps/app`, and this is the `packages/app` component that owns the popup.
 *
 * `toBeVisible()` is deliberately absent: it rejects `visibility: hidden` and a
 * zero box, and passes happily on an element clipped away by an ancestor's
 * overflow, which is exactly the defect. What is asserted instead is the
 * structural fact that changed — the popup's containing block is the viewport
 * (`position: fixed`, which an `overflow` ancestor cannot clip) and its geometry
 * is measured from the input's viewport rect and re-measured when the section
 * scrolls.
 */

const { navigate, mockUseUnifiedSearch, mockUseSearchIntellisense } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    mockUseUnifiedSearch: vi.fn(),
    mockUseSearchIntellisense: vi.fn(),
  }));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (orgRelativePath: string) => `/acme${orgRelativePath}`,
}));

vi.mock("@repo/app/search/hooks/use-search", () => ({
  useUnifiedSearch: (params: unknown, options?: { enabled?: boolean }) =>
    mockUseUnifiedSearch(params, options),
}));

vi.mock("../../hooks/use-search-intellisense", () => ({
  useSearchIntellisense: (raw: string, caret: number) =>
    mockUseSearchIntellisense(raw, caret),
}));

import { SEARCH_POPUP_TEST_ID } from "../search-popup-test-id";
import { SearchTypeahead } from "../search-typeahead";

/** The `SidebarContent` under test, tagged so the case can hold the scroller. */
const SCROLLER_TEST_ID = "labs-scroll-region";

/** Anchor geometry the stubbed rect reports; mutated to simulate a scroll. */
let anchorTop = 0;

function hit(): SearchHit {
  return {
    entityType: SearchEntityType.AgentSession,
    entityId: "session-1",
    title: "Alpha session",
    snippet: "run the <b>alpha</b> session",
    rank: 0.5,
    updatedAt: new Date("2026-01-01"),
    deepLink: "/sessions/session-1",
  };
}

/**
 * The ancestor chain ISS-8759's flag-ON path produces: the scrolling
 * `SidebarContent` → the Labs `SidebarCollapsibleSection` → the typeahead.
 */
function LabsSidebarHarness() {
  const [value, setValue] = useState("");
  return (
    <SidebarContent data-testid={SCROLLER_TEST_ID}>
      <SidebarCollapsibleSection title="Labs">
        <SearchTypeahead
          onClear={() => setValue("")}
          onSubmit={vi.fn()}
          onValueChange={setValue}
          showClear={value.length > 0}
          value={value}
        />
      </SidebarCollapsibleSection>
    </SidebarContent>
  );
}

/** Type past the two-character floor so the FTS popup opens. */
async function openPopup(): Promise<HTMLElement> {
  await userEvent.type(screen.getByRole("combobox"), "al");
  return await screen.findByTestId(SEARCH_POPUP_TEST_ID);
}

beforeEach(() => {
  navigate.mockReset();
  anchorTop = ANCHOR_TOP_INITIAL;
  mockUseSearchIntellisense.mockReturnValue({
    isOpen: false,
    mode: "free-text" as const,
    rows: [],
    isLoading: false,
    isError: false,
    commitRow: vi.fn(),
  });
  mockUseUnifiedSearch.mockReturnValue({
    data: { results: [hit()] },
    isLoading: false,
    isError: false,
  });
  // jsdom lays nothing out, so every rect is zero and no geometry assertion
  // could tell a measured placement from an unmeasured one. Reporting a real
  // anchor box — and moving it — is what makes the placement observable.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function boundingRect(this: HTMLElement): DOMRect {
      return anchorRect(anchorTop);
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ISS-8777 — the search popup escapes the Labs scroll region", () => {
  it("AC1/AC2 — keeps the popup inside the Labs section while taking the viewport as its containing block", async () => {
    render(<LabsSidebarHarness />);

    // Positive siblings for the structural claim below: the ancestor really is
    // the shipped scroll container (jsdom applies no Tailwind, so the class list
    // is where `overflow-auto` is legible), and the popup really does render.
    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    expect(scroller.className).toContain("overflow-auto");

    const popup = await openPopup();
    expect(within(popup).getByRole("listbox")).toBeInTheDocument();

    // AC2: the fix is NOT "move Search out of the group" — the popup is still a
    // descendant of the scrolling section, exactly where ISS-8759 puts it.
    expect(scroller.contains(popup)).toBe(true);
    // ...and it is not clipped by it, because a fixed box's containing block is
    // the viewport, which an `overflow` ancestor cannot clip.
    expect(getComputedStyle(popup).position).toBe("fixed");
  });

  it("places the popup against the input's viewport rect rather than laying it out in the scroller", async () => {
    render(<LabsSidebarHarness />);

    const popup = await openPopup();

    // Derived from the anchor box: 8px in on each side, 4px below its bottom
    // edge — the insets the popup used to get from `inset-x-2` / `mt-1`.
    expect(popup.style.top).toBe(`${ANCHOR_TOP_INITIAL + ANCHOR_HEIGHT + 4}px`);
    expect(popup.style.left).toBe(`${ANCHOR_LEFT + 8}px`);
    expect(popup.style.width).toBe(`${ANCHOR_WIDTH - 16}px`);
  });

  it("re-measures when the Labs section scrolls, so the popup tracks the input", async () => {
    render(<LabsSidebarHarness />);

    const popup = await openPopup();
    expect(popup.style.top).toBe(`${ANCHOR_TOP_INITIAL + ANCHOR_HEIGHT + 4}px`);

    // A fixed box does not move with the scroll container it sits in, so the
    // listener is what keeps it on the input. The event is dispatched on the
    // section itself and does not bubble — a window listener only sees it
    // because it is registered for the capture phase.
    anchorTop = ANCHOR_TOP_SCROLLED;
    fireEvent.scroll(screen.getByTestId(SCROLLER_TEST_ID));

    expect(popup.style.top).toBe(
      `${ANCHOR_TOP_SCROLLED + ANCHOR_HEIGHT + 4}px`
    );
  });

  it("tracks an ancestor whose position animates, which fires no scroll, resize, or resize-observer signal", async () => {
    render(<LabsSidebarHarness />);

    const popup = await openPopup();
    expect(popup.style.top).toBe(`${ANCHOR_TOP_INITIAL + ANCHOR_HEIGHT + 4}px`);

    // The two ways the anchor moves WITHOUT an event: `Ctrl/Cmd+B` slides the
    // sidebar under a `left` transition, and `MobileSearchOverlay`'s
    // `SheetContent` slides in under a transform. Both change the anchor's
    // POSITION and nothing else, so neither emits scroll or resize, and
    // `ResizeObserver` reports no entry because the size is unchanged. Nothing
    // is dispatched here for the same reason — only the frame loop can see it.
    anchorTop = ANCHOR_TOP_SCROLLED;

    await waitFor(() =>
      expect(popup.style.top).toBe(
        `${ANCHOR_TOP_SCROLLED + ANCHOR_HEIGHT + 4}px`
      )
    );
  });

  it("flips the popup above the input when the viewport leaves no usable room below it", async () => {
    vi.stubGlobal("innerHeight", SHORT_VIEWPORT_HEIGHT);
    anchorTop = ANCHOR_TOP_NEAR_BOTTOM;
    render(<LabsSidebarHarness />);

    const popup = await openPopup();

    // Below the input there are 26px — the list would render entirely under the
    // fold. Placed above, it is bounded by the input's own top edge.
    expect(popup.style.bottom).toBe(
      `${SHORT_VIEWPORT_HEIGHT - ANCHOR_TOP_NEAR_BOTTOM + 4}px`
    );
    // Positive control on that absence: `top` is cleared BECAUSE the placement
    // flipped, not because no geometry was ever applied.
    expect(popup.style.top).toBe("");
    expect(popup.style.left).toBe(`${ANCHOR_LEFT + 8}px`);
  });

  it("caps the popup to the space it actually has, so the list scrolls inside the viewport", async () => {
    vi.stubGlobal("innerHeight", SHORT_VIEWPORT_HEIGHT);
    anchorTop = ANCHOR_TOP_INITIAL;
    render(<LabsSidebarHarness />);

    const popup = await openPopup();

    // 400 − (200 + 32) − 4 gap − 8 margin. Below the input is still the
    // preferred side here; what changed is that the layer no longer claims
    // more height than the viewport can show.
    expect(popup.style.top).toBe(`${ANCHOR_TOP_INITIAL + ANCHOR_HEIGHT + 4}px`);
    expect(popup.style.maxHeight).toBe(
      `${SHORT_VIEWPORT_HEIGHT - (ANCHOR_TOP_INITIAL + ANCHOR_HEIGHT) - 4 - 8}px`
    );
  });

  it("AC4 — keeps the popup wired to the combobox and dismissable with Escape", async () => {
    render(<LabsSidebarHarness />);

    const popup = await openPopup();
    const combobox = screen.getByRole("combobox");

    // The popup moved its containing block, not its ARIA relationship: the
    // listbox `aria-controls` names is the one inside the positioned layer.
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    const listbox = within(popup).getByRole("listbox");
    expect(combobox.getAttribute("aria-controls")).toBe(listbox.id);

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId(SEARCH_POPUP_TEST_ID)).toBeNull();
    // Positive sibling for that absence: the box itself survived the dismissal.
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});

const ANCHOR_TOP_INITIAL = 200;
const ANCHOR_TOP_SCROLLED = 40;
/** A viewport short enough that placement has to reckon with its edges. */
const SHORT_VIEWPORT_HEIGHT = 400;
/** Leaves 26px below the input — under the floor a usable list needs. */
const ANCHOR_TOP_NEAR_BOTTOM = 330;
const ANCHOR_LEFT = 24;
const ANCHOR_WIDTH = 200;
const ANCHOR_HEIGHT = 32;

function anchorRect(top: number): DOMRect {
  return {
    bottom: top + ANCHOR_HEIGHT,
    height: ANCHOR_HEIGHT,
    left: ANCHOR_LEFT,
    right: ANCHOR_LEFT + ANCHOR_WIDTH,
    top,
    width: ANCHOR_WIDTH,
    x: ANCHOR_LEFT,
    y: top,
    toJSON: () => ({}),
  };
}
