import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createHrefLink } from "../href-link";
import type { NavigationActions } from "../navigation-adapter";

/**
 * `createHrefLink` backs the routerless adapters (memory + the desktop
 * renderer). `navigation-port.test.tsx` covers it through the memory adapter's
 * identity `renderHref`; this file pins the arms that path cannot reach — the
 * remaining browser-deferral conditions and the non-identity `renderHref`
 * transform the desktop renderer ships (a `#/path` hash Electron's navigation
 * guard will actually resolve).
 */
function createActions() {
  return {
    navigate: vi.fn(),
    replace: vi.fn(),
  } satisfies Pick<NavigationActions, "navigate" | "replace">;
}

describe("createHrefLink browser-deferral arms", () => {
  it("defers to the browser for an altKey click", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions);
    render(<HrefLink href="/dest">go</HrefLink>);

    fireEvent.click(screen.getByRole("link", { name: "go" }), { altKey: true });

    expect(actions.navigate).not.toHaveBeenCalled();
    expect(actions.replace).not.toHaveBeenCalled();
  });

  it("defers to the browser for a non-primary (middle) click", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions);
    render(<HrefLink href="/dest">go</HrefLink>);

    fireEvent.click(screen.getByRole("link", { name: "go" }), { button: 1 });

    expect(actions.navigate).not.toHaveBeenCalled();
  });

  it("defers when an onClick handler already prevented the default", () => {
    const actions = createActions();
    const onClick = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const HrefLink = createHrefLink(actions);
    render(
      <HrefLink href="/dest" onClick={onClick}>
        go
      </HrefLink>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(actions.navigate).not.toHaveBeenCalled();
  });

  it("runs the caller's onClick before navigating on a plain click", () => {
    const actions = createActions();
    const onClick = vi.fn();
    const HrefLink = createHrefLink(actions);
    render(
      <HrefLink href="/dest" onClick={onClick}>
        go
      </HrefLink>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(actions.navigate).toHaveBeenCalledWith("/dest");
  });

  it("navigates for an explicit target=_self, which does not open elsewhere", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions);
    render(
      <HrefLink href="/dest" target="_self">
        go
      </HrefLink>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }));

    expect(actions.navigate).toHaveBeenCalledWith("/dest");
  });
});

describe("createHrefLink renderHref transform", () => {
  it("renders the transformed href while navigating the internal path", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions, (href) => `#${href}`);
    render(<HrefLink href="/agents/foo">go</HrefLink>);

    const anchor = screen.getByRole("link", { name: "go" });
    // The browser-deferred paths (modifier/middle/context-menu) follow this
    // attribute, so it must be surface-resolvable...
    expect(anchor.getAttribute("href")).toBe("#/agents/foo");

    fireEvent.click(anchor);

    // ...while the click handler still navigates the untransformed path.
    expect(actions.navigate).toHaveBeenCalledWith("/agents/foo");
  });

  it("keeps the transform out of the replace path's navigation target", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions, (href) => `#${href}`);
    render(
      <HrefLink href="/agents/foo" replace>
        go
      </HrefLink>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }));

    expect(actions.replace).toHaveBeenCalledWith("/agents/foo");
    expect(actions.navigate).not.toHaveBeenCalled();
  });

  it("defaults to an identity transform when none is supplied", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions);
    render(<HrefLink href="/agents/foo">go</HrefLink>);

    expect(screen.getByRole("link", { name: "go" }).getAttribute("href")).toBe(
      "/agents/foo"
    );
  });

  it("forwards arbitrary anchor props and drops the router-only ones", () => {
    const actions = createActions();
    const HrefLink = createHrefLink(actions);
    render(
      <HrefLink
        className="styled"
        data-testid="nav-link"
        href="/dest"
        prefetch
        scroll={false}
      >
        go
      </HrefLink>
    );

    const anchor = screen.getByTestId("nav-link");
    expect(anchor.getAttribute("class")).toBe("styled");
    // `prefetch`/`scroll` are next/link concerns with no anchor equivalent;
    // leaking them would emit invalid DOM attributes.
    expect(anchor.hasAttribute("prefetch")).toBe(false);
    expect(anchor.hasAttribute("scroll")).toBe(false);
  });
});
