/**
 * @file use-packs-route-selection.test.tsx
 * @description ISS-6925 — pack-detail selection read from the route. Covers the
 * id derivation (including the cross-route guard), the hrefs the hook emits on
 * each shell's path shape, and the back-to-grid target.
 */
import { packDetailPath } from "@repo/app/packs/lib/pack-routes";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import type { RouteParams } from "@repo/navigation/navigation-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { usePacksRouteSelection } from "../use-packs-route-selection";

const PACK_ID = "pack-abc";

function renderSelection(options: {
  initialPath: string;
  routeParams?: RouteParams;
  orgSlug?: string;
}) {
  const nav: MemoryNavigation = createMemoryNavigation(options);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const { result } = renderHook(() => usePacksRouteSelection(), { wrapper });
  return { nav, result };
}

describe("usePacksRouteSelection", () => {
  it("reads the addressed pack off a web detail path", () => {
    const { result } = renderSelection({
      initialPath: `/acme${packDetailPath(PACK_ID)}`,
      orgSlug: "acme",
      routeParams: { id: PACK_ID },
    });

    expect(result.current.selectedPackId).toBe(PACK_ID);
  });

  it("reads the addressed pack off a desktop detail path, which has no org prefix", () => {
    const { result } = renderSelection({
      initialPath: packDetailPath(PACK_ID),
      routeParams: { id: PACK_ID },
    });

    expect(result.current.selectedPackId).toBe(PACK_ID);
  });

  it("selects nothing on the discovery grid", () => {
    const { result } = renderSelection({
      initialPath: "/acme/packs",
      orgSlug: "acme",
    });

    expect(result.current.selectedPackId).toBeNull();
  });

  /**
   * `id` is not this route's param alone: `/agents/:id` produces one too, and
   * the desktop `PluginsPanel` is mounted on the Agents view as well as Packs.
   * Without the path check the panel would read an agent slug as a pack id and
   * open a detail nobody asked for.
   */
  it("ignores an `id` param belonging to another route", () => {
    const { result } = renderSelection({
      initialPath: "/acme/agents/some-agent",
      orgSlug: "acme",
      routeParams: { id: "some-agent" },
    });

    expect(result.current.selectedPackId).toBeNull();
  });

  it("navigates to the org-scoped detail href when a pack is selected", () => {
    const { nav, result } = renderSelection({
      initialPath: "/acme/packs",
      orgSlug: "acme",
    });

    result.current.selectPack(PACK_ID);

    expect(nav.getCurrentHref()).toBe(`/acme${packDetailPath(PACK_ID)}`);
  });

  it("navigates back to the grid when the selection is cleared", () => {
    const { nav, result } = renderSelection({
      initialPath: `/acme${packDetailPath(PACK_ID)}`,
      orgSlug: "acme",
      routeParams: { id: PACK_ID },
    });

    result.current.selectPack(null);

    expect(nav.getCurrentHref()).toBe("/acme/packs");
  });

  it("pushes history entries, so Back moves between packs", () => {
    const { nav, result } = renderSelection({
      initialPath: "/acme/packs",
      orgSlug: "acme",
    });

    result.current.selectPack(PACK_ID);
    result.current.selectPack("pack-def");

    expect(nav.getHistory()).toEqual([
      "/acme/packs",
      `/acme${packDetailPath(PACK_ID)}`,
      `/acme${packDetailPath("pack-def")}`,
    ]);
  });

  // FEA-4159 class: the desktop `PacksView` mount guard renders this whole tree
  // with NO providers and asserts it does not throw, because a hard-throwing
  // hook there is a blank application window rather than a failed subtree.
  it("degrades to an inert selection with no navigation provider mounted", () => {
    const { result } = renderHook(() => usePacksRouteSelection());

    expect(result.current.selectedPackId).toBeNull();
    expect(result.current.isPacksRoute).toBe(false);
    expect(() => result.current.selectPack(PACK_ID)).not.toThrow();
  });

  // The WRITE-side scope. `PluginsPanel` is mounted on the Agents view too, so
  // without this a card click there would navigate the reader onto Packs
  // instead of opening the detail in place.
  it("does not claim the Packs route on another surface", () => {
    const { result } = renderSelection({
      initialPath: "/acme/agents/some-agent",
      orgSlug: "acme",
      routeParams: { id: "some-agent" },
    });

    expect(result.current.isPacksRoute).toBe(false);
  });

  it("claims the Packs route on both the grid and a detail, on either shell", () => {
    for (const initialPath of [
      "/acme/packs",
      `/acme${packDetailPath(PACK_ID)}`,
      "/packs",
      packDetailPath(PACK_ID),
    ]) {
      const { result } = renderSelection({ initialPath });
      expect(result.current.isPacksRoute, initialPath).toBe(true);
    }
  });

  it("points the back affordance at the org-scoped grid", () => {
    const { result } = renderSelection({
      initialPath: `/acme${packDetailPath(PACK_ID)}`,
      orgSlug: "acme",
      routeParams: { id: PACK_ID },
    });

    expect(result.current.backHref).toBe("/acme/packs");
  });
});
