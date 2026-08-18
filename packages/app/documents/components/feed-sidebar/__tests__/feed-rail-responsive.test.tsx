import {
  FeedRail,
  FeedRailTab,
} from "@repo/design-system/components/ui/feed-rail";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// FEA-3865: FeedRail gains a `mode` prop and a below-`sm` bottom-sheet layout.
// `useMediaQuery` reads `globalThis.matchMedia`, which jsdom does not implement,
// so stub it per-test. `matches` is driven by the query string so we can steer
// the adaptive `inline` mode across breakpoints.

function stubMatchMedia(matcher: (query: string) => boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: matcher(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
}

const commonProps = {
  activeTab: FeedRailTab.Feed,
  chatPanel: null,
  feedPanel: <div data-testid="feed-panel">Feed body</div>,
  hasChat: false,
  onClose: vi.fn(),
  onTabChange: vi.fn(),
  onWidthChange: vi.fn(),
  visible: true,
  width: 380,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FeedRail responsive layout (FEA-3865)", () => {
  it("renders a bottom sheet with no resize handle in sheet mode", () => {
    // Every query resolves false — the forced sheet mode must ignore that.
    stubMatchMedia(() => false);
    render(<FeedRail {...commonProps} mode="sheet" />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("feed-panel")).toBeInTheDocument();
    // The pointer resize handle is inline-only.
    expect(
      screen.queryByRole("button", { name: "Resize feed rail" })
    ).not.toBeInTheDocument();
  });

  it("resolves the adaptive inline mode to a bottom sheet below sm", () => {
    // Both the mobile (<640) and narrow (<=1024) queries match → sheet wins.
    stubMatchMedia(() => true);
    render(<FeedRail {...commonProps} mode="inline" />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resize feed rail" })
    ).not.toBeInTheDocument();
  });

  it("keeps the inline resizable rail on wide viewports", () => {
    // No query matches → not mobile, not narrow → inline rail with a handle.
    stubMatchMedia(() => false);
    render(<FeedRail {...commonProps} mode="inline" />);

    expect(
      screen.getByRole("button", { name: "Resize feed rail" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
