import { GRID_TABLE_V2_NARROW_VIEWPORT_QUERY } from "@repo/design-system/lib/grid-table-v2-responsive";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import type { RouteParams } from "@repo/navigation/navigation-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import type { Decorator } from "@storybook/react";
import { type ReactNode, useState } from "react";
import { expect, within } from "storybook/test";

// Puts a Surfaces page at its live URL. The preview's shared navigation
// port sits at "/", but route components read where they are (the path, its
// query, or a dynamic segment such as `[id]`) to decide what to render, so a
// page is mounted at its own path with the route params Next.js would hand it.

export const LIVE_ORG_SLUG = "org-test";

/** Gives narrow story tests the viewport signal supplied by the browser addon. */
export function narrowStoryViewport(): () => void {
  if (import.meta.env.MODE !== "test") {
    return () => undefined;
  }

  const innerWidthDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "innerWidth"
  );
  const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "matchMedia"
  );
  const originalMatchMedia = globalThis.window.matchMedia.bind(
    globalThis.window
  );
  const narrowMedia: MediaQueryList = {
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => true,
    matches: true,
    media: GRID_TABLE_V2_NARROW_VIEWPORT_QUERY,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  };
  Object.defineProperty(globalThis.window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: (query: string) =>
      query === GRID_TABLE_V2_NARROW_VIEWPORT_QUERY
        ? narrowMedia
        : originalMatchMedia(query),
  });
  globalThis.window.dispatchEvent(new Event("resize"));
  return () => {
    if (innerWidthDescriptor) {
      Object.defineProperty(
        globalThis.window,
        "innerWidth",
        innerWidthDescriptor
      );
    } else {
      Reflect.deleteProperty(globalThis.window, "innerWidth");
    }
    if (matchMediaDescriptor) {
      Object.defineProperty(
        globalThis.window,
        "matchMedia",
        matchMediaDescriptor
      );
    } else {
      Reflect.deleteProperty(globalThis.window, "matchMedia");
    }
    globalThis.window.dispatchEvent(new Event("resize"));
  };
}

/**
 * The URL a page is rendered at, declared per story as
 * `parameters.liveRoute`: the path (with any query the page reads) and the
 * dynamic route segments (`id`, `branchId`, ...).
 */
export type LiveRouteSpec = {
  path: string;
  params?: RouteParams;
};

function RouteNavigation({
  initialPath,
  params,
  children,
}: {
  initialPath: string;
  params?: RouteParams;
  children: ReactNode;
}) {
  const [navigation] = useState(() =>
    createMemoryNavigation({
      initialPath,
      orgSlug: LIVE_ORG_SLUG,
      routeParams: { orgSlug: LIVE_ORG_SLUG, ...params },
    })
  );
  return (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}

/** Mounts the navigation port at `parameters.liveRoute` for this story. */
export const withLiveRoute: Decorator = (Story, context) => {
  const route = context.parameters.liveRoute as LiveRouteSpec | undefined;
  if (!route) {
    return <Story />;
  }
  return (
    <RouteNavigation
      initialPath={route.path}
      key={context.id}
      params={route.params}
    >
      <Story />
    </RouteNavigation>
  );
};

/**
 * The same, as a component: `path` is org-relative (e.g. "/packs") and is
 * mounted under the org slug.
 */
export function LiveRoute({
  path,
  params,
  children,
}: {
  path: string;
  params?: RouteParams;
  children: ReactNode;
}) {
  return (
    <RouteNavigation initialPath={`/${LIVE_ORG_SLUG}${path}`} params={params}>
      {children}
    </RouteNavigation>
  );
}

/**
 * Asserts the Global Nav item `name` is the active one. A page's breadcrumb
 * can carry a link with the same name, so the sidebar link is picked out by
 * its `data-active` attribute rather than by name alone. Takes the story's
 * canvas element or a `within(...)` query object.
 */
export async function expectActiveNavItem(
  target: HTMLElement | ReturnType<typeof within>,
  name: string | RegExp
) {
  const canvas = target instanceof HTMLElement ? within(target) : target;
  const links = await canvas.findAllByRole("link", { name });
  await expect(
    links.some(
      (link: HTMLElement) => link.getAttribute("data-active") === "true"
    )
  ).toBe(true);
}
