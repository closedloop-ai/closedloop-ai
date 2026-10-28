/**
 * ISS-10903: the App-shell content viewport's per-href scroll memory
 * (PLN-1950 slice 5). The shell owns ONE scrolling element serving every route,
 * so the remembered position is keyed by nav href in a module-level LRU map —
 * which makes three things worth pinning that the shared contract module does
 * not own: the capture gate (a route with no restorable list captures nothing),
 * the map's own bounded growth, and desktop's retry loop, whose continuation
 * predicate is deliberately NOT the one `apps/app` uses.
 *
 * The position map is module-level and outlives each case, so every case here
 * uses its own unique href. Nothing below depends on a preceding case having
 * primed it, and nothing leaves a key a later case reads.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS,
  MAX_REMEMBERED_SCROLL_POSITIONS,
  restoreContentScrollPosition,
  useContentScrollRestoration,
} from "../use-content-scroll-restoration";

/** Unique per case so the module-level position map cannot couple them. */
let hrefSeq = 0;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useContentScrollRestoration — capture", () => {
  it("remembers a position under its href and restores it on return", () => {
    const href = nextHref();
    const view = renderViewport(href, {
      scrollHeight: 1000,
      clientHeight: 200,
    });

    view.scrollTo(300);
    // Leave for a route that owns no restorable position, then come back.
    view.rerenderWith(null);
    view.rerenderWith(href);

    expect(view.element().scrollTop).toBe(300);
  });

  it("captures nothing while the active route owns no restorable position", () => {
    const href = nextHref();
    const view = renderViewport(href, {
      scrollHeight: 1000,
      clientHeight: 200,
    });

    // Seed a real, legitimately-captured position under `href`, then leave
    // for a route with no restorable list and scroll there too. If that scroll
    // were wrongly captured, it would land under `href` and clobber the seed —
    // so returning to `href` and getting the ORIGINAL 150 back is the proof
    // that the null route captured nothing, not just that a zeroed element
    // stayed zero.
    view.scrollTo(150);
    view.rerenderWith(null);
    view.scrollTo(250);
    view.rerenderWith(href);

    expect(view.element().scrollTop).toBe(150);
  });

  it("keys positions independently, so one route cannot restore another's", () => {
    const first = nextHref();
    const second = nextHref();
    const view = renderViewport(first, {
      scrollHeight: 1000,
      clientHeight: 200,
    });

    view.scrollTo(400);
    view.rerenderWith(second);

    expect(view.element().scrollTop).toBe(0);

    view.rerenderWith(first);
    expect(view.element().scrollTop).toBe(400);
  });

  it("floors a negative scrollTop at zero rather than remembering it", () => {
    const href = nextHref();
    const view = renderViewport(href, {
      scrollHeight: 1000,
      clientHeight: 200,
    });

    view.scrollTo(-120);
    view.rerenderWith(null);
    view.rerenderWith(href);

    expect(view.element().scrollTop).toBe(0);
  });

  it("ignores a non-finite scrollTop instead of storing it", () => {
    const href = nextHref();
    const view = renderViewport(href, {
      scrollHeight: 1000,
      clientHeight: 200,
    });

    view.scrollTo(275);
    // A viewport that reports NaN must not overwrite the good stored value.
    view.reportScrollTop(Number.NaN);
    fireEvent.scroll(view.element());
    view.reportScrollTop(0);

    view.rerenderWith(null);
    view.rerenderWith(href);

    expect(view.element().scrollTop).toBe(275);
  });

  it("bounds the position map, evicting the oldest href past the cap", () => {
    const oldest = nextHref();
    const view = renderViewport(oldest, {
      scrollHeight: 1000,
      clientHeight: 200,
    });
    view.scrollTo(410);

    // Walking MAX_REMEMBERED_SCROLL_POSITIONS further hrefs must push `oldest` out.
    for (let index = 0; index < MAX_REMEMBERED_SCROLL_POSITIONS; index += 1) {
      const href = nextHref();
      view.rerenderWith(href);
      view.scrollTo(10 + index);
    }
    view.rerenderWith(oldest);

    expect(view.element().scrollTop).toBe(0);
  });
});

describe("useContentScrollRestoration — a route that owns its own scroller", () => {
  it("remembers and restores the registered band, not the viewport above it", () => {
    const href = nextHref();
    const view = renderShellWithBand(href);

    view.scrollBandTo(420);
    view.rerenderWith(null);
    view.rerenderWith(href);

    expect(view.band().scrollTop).toBe(420);
  });

  it("keeps the band's offset and the viewport's in separate slots", () => {
    const href = nextHref();
    const view = renderShellWithBand(href, { scrollableViewport: true });

    view.scrollBandTo(360);
    view.scrollViewportTo(90);
    view.rerenderWith(null);
    view.rerenderWith(href);

    // One slot per element: either capture landing on the other's offset would
    // restore one of these to the other's value.
    expect(view.band().scrollTop).toBe(360);
    expect(view.viewport().scrollTop).toBe(90);
  });

  it("lets a kept-alive band from another route keep its own offset", () => {
    const listHref = nextHref();
    const otherHref = nextHref();
    // Keep-alive leaves a visited view MOUNTED but hidden, so the band stays
    // registered while the reader is on a route whose viewport does overflow.
    const view = renderShellWithBand(listHref, { scrollableViewport: true });

    view.scrollBandTo(300);
    view.rerenderWith(otherHref);
    view.scrollViewportTo(120);

    view.rerenderWith(listHref);
    expect(view.band().scrollTop).toBe(300);

    // The other route's viewport offset survived the list's band holding a
    // registration the whole time.
    view.rerenderWith(otherHref);
    expect(view.viewport().scrollTop).toBe(120);
  });

  it("restores a band that mounts after the route became active", () => {
    const href = nextHref();
    const seed = renderShellWithBand(href);
    seed.scrollBandTo(300);
    seed.unmount();

    // The route's rows -- and the band with them -- arrive commits after the
    // route does, which is when the shell's own layout effect has already run.
    const view = renderShellWithBand(href, { bandMounted: false });
    expect(view.queryBand()).toBeNull();
    view.mountBand();

    expect(view.band().scrollTop).toBe(300);
  });

  it("resumes a restore that expired while the list was still reading rows", () => {
    const href = nextHref();
    const seed = renderShellWithBand(href);
    seed.scrollBandTo(300);
    seed.unmount();

    // Unwind the whole bounded loop inside each aim, the way 30 real frames
    // would while the band still cannot hold the offset.
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 1;
    });

    // Unlike the late-band case above, the band is ALREADY there when the route
    // activates -- `SessionsListSurfaceV2` renders `GridTableListSurface` while
    // its read is pending and swaps only the inner body -- it just cannot hold
    // the offset yet.
    const view = renderShellWithBand(href, { bandHoldsScroll: false });
    expect(view.band().scrollTop).toBe(0);

    view.deliverBandRows();

    expect(view.band().scrollTop).toBe(300);
  });

  it("does not re-restore when the surface re-attaches the same node", () => {
    const href = nextHref();
    const view = renderShellWithBand(nextHref());

    // Mid-scroll, the live `scrollTop` runs AHEAD of the last scroll event the
    // browser delivered: events are coalesced to a frame while the scrolled
    // offset is current. This surface re-renders off that same scroll (its row
    // window repaints), so a re-render lands in that gap routinely.
    view.rerenderWith(href);
    view.scrollBandTo(300);
    view.advanceBandWithoutEvent(500);
    view.rerenderWith(href);

    // Re-restoring on re-attach would snap the reader back to 300.
    expect(view.band().scrollTop).toBe(500);
  });

  it("still restores the viewport on a route that has no band at all", () => {
    const href = nextHref();
    const view = renderShellWithBand(href, { scrollableViewport: true });

    view.unmountBand();
    view.scrollViewportTo(140);
    view.rerenderWith(null);
    view.rerenderWith(href);

    expect(view.viewport().scrollTop).toBe(140);
  });
});

describe("restoreContentScrollPosition — the bounded retry", () => {
  it("clamps the target to what the container can currently hold", () => {
    const element = viewportElement({ scrollHeight: 500, clientHeight: 200 });

    restoreContentScrollPosition(element, 9999);

    expect(element.scrollTop).toBe(300);
  });

  it("assigns once and stops when the assignment takes", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const element = viewportElement({ scrollHeight: 1000, clientHeight: 200 });

    restoreContentScrollPosition(element, 250);

    expect(element.scrollTop).toBe(250);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("retries on the next frame while the container has not grown scrollable", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    // A container with no layout yet: the assignment cannot take.
    const element = viewportElement(
      { scrollHeight: 0, clientHeight: 0 },
      { holdsScroll: false }
    );

    restoreContentScrollPosition(element, 300);
    expect(frames).toHaveLength(1);

    // Layout arrives and the container now holds a position: the next attempt
    // takes and the loop stops.
    const settled = viewportElement({ scrollHeight: 1000, clientHeight: 200 });
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => settled.scrollTop,
      set: (value: number) => {
        settled.scrollTop = value;
      },
    });
    setMetrics(element, { scrollHeight: 1000, clientHeight: 200 });
    frames[0]?.();

    expect(element.scrollTop).toBe(300);
    expect(frames).toHaveLength(1);
  });

  it("never retries for a remembered position of zero", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const element = viewportElement({ scrollHeight: 0, clientHeight: 0 });

    restoreContentScrollPosition(element, 0);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("gives up at the shared attempt ceiling rather than looping forever", () => {
    let scheduled = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      scheduled += 1;
      // Run the continuation synchronously so the whole bounded loop unwinds.
      cb();
      return scheduled;
    });
    const element = viewportElement(
      { scrollHeight: 0, clientHeight: 0 },
      { holdsScroll: false }
    );

    restoreContentScrollPosition(element, 300);

    // The first attempt is direct; the rest are scheduled, up to the ceiling.
    expect(scheduled).toBe(MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS - 1);
  });

  it("does not schedule a frame in an environment without requestAnimationFrame", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const element = viewportElement(
      { scrollHeight: 0, clientHeight: 0 },
      { holdsScroll: false }
    );

    expect(() => restoreContentScrollPosition(element, 300)).not.toThrow();
    expect(element.scrollTop).toBe(0);
  });

  it("cancels a pending frame on dispose and stops applying", () => {
    const frames: Array<() => void> = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const element = viewportElement(
      { scrollHeight: 0, clientHeight: 0 },
      { holdsScroll: false }
    );

    const dispose = restoreContentScrollPosition(element, 300);
    dispose();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);

    // A frame that still fires after dispose must not touch the element.
    let written: number | null = null;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => written ?? 0,
      set: (value: number) => {
        written = value;
      },
    });
    setMetrics(element, { scrollHeight: 1000, clientHeight: 200 });
    frames[0]?.();
    expect(written).toBeNull();
  });

  it("disposes cleanly when no frame was ever scheduled", () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const element = viewportElement({ scrollHeight: 1000, clientHeight: 200 });

    const dispose = restoreContentScrollPosition(element, 250);
    dispose();

    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("survives an environment without cancelAnimationFrame", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const element = viewportElement(
      { scrollHeight: 0, clientHeight: 0 },
      { holdsScroll: false }
    );

    const dispose = restoreContentScrollPosition(element, 300);

    expect(() => dispose()).not.toThrow();
  });
});

/**
 * A band whose `scrollTop` assignment does not take, which is the state a
 * `GridTableListSurface` is in while its rows are still being read: the node
 * exists, its loading body does not overflow. jsdom stores whatever is written,
 * so the refusal has to be installed.
 */
function holdBandScroll(node: HTMLElement, holdsScroll: boolean): void {
  if (holdsScroll) {
    Reflect.deleteProperty(node, "scrollTop");
    return;
  }
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => 0,
    set: () => undefined,
  });
}

function nextHref(): string {
  hrefSeq += 1;
  return `#/iss-10903-route-${hrefSeq}`;
}

type Metrics = { scrollHeight: number; clientHeight: number };

function setMetrics(element: HTMLElement, metrics: Metrics): void {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
}

/**
 * A detached scrolling container. `holdsScroll: false` models the case the
 * retry loop exists for — a container with no layout yet, whose `scrollTop`
 * assignment does not take — which jsdom cannot reproduce on its own because
 * it stores whatever is written.
 */
function viewportElement(
  metrics: Metrics,
  options: { holdsScroll?: boolean } = {}
): HTMLElement {
  const element = document.createElement("div");
  setMetrics(element, metrics);
  if (options.holdsScroll === false) {
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    });
  }
  return element;
}

/**
 * Mount the hook on a real scrolling div, so the layout effect sees a live
 * ref the way the App shell gives it one.
 */
function renderViewport(initialKey: string | null, metrics: Metrics) {
  let scrollTopOverride: number | null = null;

  function Viewport({ navKey }: { navKey: string | null }) {
    const { contentViewportRef, handleContentViewportScroll } =
      useContentScrollRestoration(navKey);
    const applied = useRef(false);
    return (
      <div
        data-testid="viewport"
        onScroll={handleContentViewportScroll}
        ref={(node) => {
          contentViewportRef.current = node;
          if (node && !applied.current) {
            applied.current = true;
            setMetrics(node, metrics);
          }
        }}
      />
    );
  }

  const utils = render(<Viewport navKey={initialKey} />);
  const element = () => utils.getByTestId("viewport") as HTMLDivElement;

  // The hook reads `scrollTop` off the live element; an override lets a case
  // feed it a value jsdom will not store (NaN).
  Object.defineProperty(element(), "scrollTop", {
    configurable: true,
    get() {
      return scrollTopOverride ?? this._scrollTop ?? 0;
    },
    set(value: number) {
      this._scrollTop = value;
    },
  });

  return {
    element,
    scrollTo(position: number) {
      act(() => {
        element().scrollTop = position;
        fireEvent.scroll(element());
      });
    },
    reportScrollTop(value: number) {
      scrollTopOverride = value;
    },
    rerenderWith(navKey: string | null) {
      scrollTopOverride = null;
      // The shell's viewport keeps whatever offset it had; zero it so that a
      // restored position is the hook's doing and not a leftover.
      element().scrollTop = 0;
      act(() => {
        utils.rerender(<Viewport navKey={navKey} />);
      });
    },
  };
}

/**
 * Mount the hook the way the App shell does on a `GridTableListSurface` route:
 * a content viewport that cannot overflow, with the band that actually scrolls
 * inside it, registered through `registerRouteScroller`. The band's ref is an
 * inline arrow, as `GridTableListSurface`'s is, so React re-runs it on every
 * render here too.
 */
function renderShellWithBand(
  initialKey: string | null,
  options: {
    bandHoldsScroll?: boolean;
    bandMounted?: boolean;
    scrollableViewport?: boolean;
  } = {}
) {
  // The ISS-12471 measurement's own numbers: on a `GridTableListSurface` route
  // the viewport's scrollHeight EQUALS its clientHeight, so it cannot overflow,
  // while the band's does not. `scrollableViewport` models the other kind of
  // route -- one whose body does overflow the shell viewport.
  const viewportMetrics: Metrics = options.scrollableViewport
    ? { scrollHeight: 2400, clientHeight: 701 }
    : { scrollHeight: 701, clientHeight: 701 };
  const bandMetrics: Metrics = { scrollHeight: 1136, clientHeight: 361 };

  function Shell({
    bandMounted,
    navKey,
  }: {
    bandMounted: boolean;
    navKey: string | null;
  }) {
    const {
      contentViewportRef,
      handleContentViewportScroll,
      registerRouteScroller,
    } = useContentScrollRestoration(navKey);
    return (
      <div
        data-testid="viewport"
        onScroll={handleContentViewportScroll}
        ref={(node) => {
          contentViewportRef.current = node;
          if (node) {
            setMetrics(node, viewportMetrics);
          }
        }}
      >
        {bandMounted ? (
          <div
            data-testid="band"
            ref={(node) => {
              if (node) {
                setMetrics(node, bandMetrics);
                holdBandScroll(node, bandHoldsScroll);
              }
              registerRouteScroller(node);
            }}
          />
        ) : null}
      </div>
    );
  }

  let bandHoldsScroll = options.bandHoldsScroll ?? true;
  let bandMounted = options.bandMounted ?? true;
  let navKey = initialKey;
  const utils = render(<Shell bandMounted={bandMounted} navKey={navKey} />);
  const rerender = () => {
    act(() => {
      utils.rerender(<Shell bandMounted={bandMounted} navKey={navKey} />);
    });
  };

  return {
    band: () => utils.getByTestId("band") as HTMLDivElement,
    deliverBandRows() {
      bandHoldsScroll = true;
      rerender();
    },
    mountBand() {
      bandMounted = true;
      rerender();
    },
    queryBand: () => utils.queryByTestId("band"),
    rerenderWith(nextNavKey: string | null) {
      // A route re-activating starts both elements at 0, so a restored offset
      // is the hook's doing and not one jsdom was still holding. A same-key
      // re-render is not a re-activation: the element really does keep its
      // offset there, which is the case the re-attach guard is about.
      if (nextNavKey !== navKey) {
        utils.getByTestId("viewport").scrollTop = 0;
        const band = utils.queryByTestId("band");
        if (band) {
          band.scrollTop = 0;
        }
      }
      navKey = nextNavKey;
      rerender();
    },
    advanceBandWithoutEvent(position: number) {
      act(() => {
        utils.getByTestId("band").scrollTop = position;
      });
    },
    scrollBandTo(position: number) {
      act(() => {
        const element = utils.getByTestId("band");
        element.scrollTop = position;
        fireEvent.scroll(element);
      });
    },
    scrollViewportTo(position: number) {
      act(() => {
        const element = utils.getByTestId("viewport");
        element.scrollTop = position;
        fireEvent.scroll(element);
      });
    },
    unmount: () => utils.unmount(),
    unmountBand() {
      bandMounted = false;
      rerender();
    },
    viewport: () => utils.getByTestId("viewport") as HTMLDivElement,
  };
}
