/**
 * ISS-12471 (marisol cid 4273664871): the shell holds ONE route-scroller slot and
 * keep-alive leaves every visited panel mounted and rendering, so whether a
 * hidden band can reach that slot is decided here and nowhere else.
 */

import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type RegisterRouteScroller,
  RouteScrollerProvider,
  useRouteScrollerRegistration,
} from "../route-scroller-context";
import { NavId } from "../route-table";

describe("RouteScrollerProvider", () => {
  it("publishes the shell registrar inside the live route's panel", () => {
    const registerRouteScroller = vi.fn();
    const band = document.createElement("div");

    renderPanel({
      activeNavId: NavId.Sessions,
      band,
      navId: NavId.Sessions,
      registerRouteScroller,
    });

    expect(registerRouteScroller).toHaveBeenCalledWith(band);
  });

  it("withholds it from a kept-alive panel that is not the live route", () => {
    const registerRouteScroller = vi.fn();

    renderPanel({
      activeNavId: NavId.Sessions,
      band: document.createElement("div"),
      navId: NavId.Branches,
      registerRouteScroller,
    });

    expect(registerRouteScroller).not.toHaveBeenCalled();
  });

  it("withholds it from every panel while a detail route is open", () => {
    const registerRouteScroller = vi.fn();

    renderPanel({
      activeNavId: null,
      band: document.createElement("div"),
      navId: NavId.Sessions,
      registerRouteScroller,
    });

    expect(registerRouteScroller).not.toHaveBeenCalled();
  });
});

function renderPanel({
  activeNavId,
  band,
  navId,
  registerRouteScroller,
}: {
  activeNavId: NavId | null;
  band: HTMLElement;
  navId: NavId;
  registerRouteScroller: RegisterRouteScroller;
}) {
  return render(
    <RouteScrollerProvider
      activeNavId={activeNavId}
      navId={navId}
      registerRouteScroller={registerRouteScroller}
    >
      <Band band={band} />
    </RouteScrollerProvider>
  );
}

/** A `GridTableListSurface` list, reduced to the one thing it publishes. */
function Band({ band }: { band: HTMLElement }) {
  const register = useRouteScrollerRegistration();
  useEffect(() => {
    register(band);
  }, [band, register]);
  return null;
}
