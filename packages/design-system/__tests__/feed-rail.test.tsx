import {
  FeedRail,
  FeedRailMode,
} from "@closedloop-ai/design-system/components/ui/feed-rail";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-7349. `FeedRail` renders as one of THREE different layouts — a resizable
 * inline rail, a fixed-width overlay with a scrim, or a bottom sheet — and
 * which one you get is a function of the requested mode AND the viewport. That
 * resolution is the component's real logic, and a story can only ever mount it
 * at whatever width the story canvas happens to be, so the two adaptive
 * breakpoint arms are unreachable from the sweep.
 */

/** Drives `useMediaQuery` so the adaptive arms are selectable in jsdom. */
function setViewportMatches(matching: readonly string[]) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: matching.includes(query),
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );
}

const NARROW = "(max-width: 1024px)";
const MOBILE = "(max-width: 639px)";

function renderRail(
  overrides: Partial<React.ComponentProps<typeof FeedRail>> = {}
) {
  const props: React.ComponentProps<typeof FeedRail> = {
    feedPanel: <div>Feed body</div>,
    onClose: vi.fn(),
    onWidthChange: vi.fn(),
    visible: true,
    width: 420,
    ...overrides,
  };
  render(<FeedRail {...props} />);
  return props;
}

beforeEach(() => {
  setViewportMatches([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FeedRail visibility", () => {
  it("renders nothing when not visible", () => {
    renderRail({ visible: false });

    expect(screen.queryByText("Feed body")).toBeNull();
  });

  it("renders the feed panel when visible", () => {
    renderRail();

    expect(screen.getByText("Feed body")).toBeInTheDocument();
  });
});

describe("FeedRail layout resolution", () => {
  it("renders the resizable inline rail on a wide viewport", () => {
    renderRail();

    expect(
      screen.getByRole("button", { name: "Resize feed rail" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close feed rail" })
    ).toBeNull();
  });

  it("honours the caller's width in inline mode", () => {
    renderRail({ width: 512 });

    expect(screen.getByText("Feed body").closest("aside")).toHaveStyle({
      width: "512px",
    });
  });

  it("becomes a scrimmed overlay between the sm and lg breakpoints", () => {
    setViewportMatches([NARROW]);

    renderRail();

    expect(
      screen.getByRole("button", { name: "Close feed rail" })
    ).toBeInTheDocument();
  });

  it("drops the resize handle in overlay mode", () => {
    // Nothing to resize against — an overlay has no draggable edge.
    setViewportMatches([NARROW]);

    renderRail();

    expect(
      screen.queryByRole("button", { name: "Resize feed rail" })
    ).toBeNull();
  });

  it("pins the overlay to a fixed width, ignoring the caller's", () => {
    setViewportMatches([NARROW]);

    renderRail({ width: 999 });

    expect(screen.getByText("Feed body").closest("aside")).toHaveStyle({
      width: "400px",
    });
  });

  it("closes from the overlay scrim", () => {
    setViewportMatches([NARROW]);
    const props = renderRail();

    fireEvent.click(screen.getByRole("button", { name: "Close feed rail" }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("becomes a bottom sheet below the sm breakpoint", () => {
    // A 400px right overlay leaves almost nothing on a phone.
    setViewportMatches([NARROW, MOBILE]);

    renderRail();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resize feed rail" })
    ).toBeNull();
  });

  it("forces the overlay when the caller pins that mode on a wide viewport", () => {
    renderRail({ mode: FeedRailMode.Overlay });

    expect(
      screen.getByRole("button", { name: "Close feed rail" })
    ).toBeInTheDocument();
  });

  it("forces the sheet when the caller pins that mode on a wide viewport", () => {
    renderRail({ mode: FeedRailMode.Sheet });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps a pinned overlay on a mobile viewport", () => {
    // A forced mode is not adaptive — the viewport must not override it.
    setViewportMatches([NARROW, MOBILE]);

    renderRail({ mode: FeedRailMode.Overlay });

    expect(
      screen.getByRole("button", { name: "Close feed rail" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("FeedRail tabs", () => {
  it("selects the Feed tab", () => {
    renderRail();

    expect(screen.getByRole("tab", { name: "Feed" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("names the tab list for assistive technology", () => {
    renderRail();

    expect(screen.getByRole("tablist")).toHaveAccessibleName("Feed mode");
  });
});

describe("FeedRail resize", () => {
  it("reports a narrower width as the handle is dragged right", () => {
    // The rail is on the RIGHT, so moving the handle right shrinks it.
    const props = renderRail({ width: 420 });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Resize feed rail" }),
      { clientX: 1000 }
    );
    fireEvent.pointerMove(globalThis.window, { clientX: 1060 });

    expect(props.onWidthChange).toHaveBeenCalledWith(360);
  });

  it("reports a wider width as the handle is dragged left", () => {
    const props = renderRail({ width: 420 });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Resize feed rail" }),
      { clientX: 1000 }
    );
    fireEvent.pointerMove(globalThis.window, { clientX: 940 });

    expect(props.onWidthChange).toHaveBeenCalledWith(480);
  });

  it("stops reporting once the pointer is released", () => {
    const props = renderRail({ width: 420 });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Resize feed rail" }),
      { clientX: 1000 }
    );
    fireEvent.pointerUp(globalThis.window);
    const callsAtRelease = vi.mocked(props.onWidthChange).mock.calls.length;
    fireEvent.pointerMove(globalThis.window, { clientX: 800 });

    expect(vi.mocked(props.onWidthChange).mock.calls).toHaveLength(
      callsAtRelease
    );
  });

  it("detaches its window listeners on unmount", () => {
    // A live pointermove listener outliving the rail would call a handler bound
    // to an unmounted tree on every mouse move.
    const onWidthChange = vi.fn();
    const { unmount } = render(
      <FeedRail
        feedPanel={<div>Feed body</div>}
        onClose={vi.fn()}
        onWidthChange={onWidthChange}
        visible
        width={420}
      />
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Resize feed rail" }),
      { clientX: 1000 }
    );

    unmount();
    fireEvent.pointerMove(globalThis.window, { clientX: 800 });

    expect(onWidthChange).not.toHaveBeenCalled();
  });
});
