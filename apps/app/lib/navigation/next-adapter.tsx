"use client";

import type {
  NavigationActions,
  NavigationAdapter,
  NavigationLinkProps,
  OrgPathBuilder,
  RouteParams,
} from "@repo/navigation/navigation-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import NextLink from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "next/navigation";
import {
  type MouseEvent,
  type ReactNode,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useNavOrgSlug } from "@/hooks/use-org-slug";

/**
 * Web (Next.js) implementation of the navigation port. This is the ONLY
 * module in apps/app that may import next/navigation client hooks or
 * next/link for navigation purposes — everything else consumes
 * @repo/navigation. Server components keep using next/navigation
 * redirect/notFound directly; those are not part of the port.
 */
export const nextNavigationAdapter: NavigationAdapter = {
  useNavigationActions,
  usePathValue,
  useRouteParamsValue,
  useSearchParamsSnapshot,
  useNavigationEpoch,
  useOrgPathBuilder,
  Link: NextAdapterLink,
};

/** Mounts the navigation port backed by the Next.js adapter. */
export function AppNavigationProvider({ children }: { children: ReactNode }) {
  return (
    <NavigationProvider adapter={nextNavigationAdapter}>
      {children}
    </NavigationProvider>
  );
}

function useNavigationActions(): NavigationActions {
  const router = useRouter();
  return useMemo(
    () => ({
      navigate: (href, options) => {
        bumpNavigationEpoch();
        router.push(href, options);
      },
      replace: (href, options) => router.replace(href, options),
      back: () => {
        bumpNavigationEpoch();
        router.back();
      },
      forward: () => {
        bumpNavigationEpoch();
        router.forward();
      },
      refresh: () => router.refresh(),
    }),
    [router]
  );
}

/**
 * Exported for the root-layout RUM and product analytics trackers, which sit ABOVE
 * `AppNavigationProvider` and so cannot reach the path through the port's
 * `usePath()`. Feature and shared code must keep using `@repo/navigation/use-path`.
 */
export function usePathValue(): string {
  return usePathname();
}

function useRouteParamsValue(): RouteParams {
  return useParams();
}

function useSearchParamsSnapshot(): URLSearchParams {
  return useSearchParams();
}

/**
 * Counts the navigations that do not come from `replace`: `navigate`, `back`,
 * `forward`, a port `Link` click and the browser's popstate. The App Router
 * hands every hook its own copy of the search params and a same-URL push
 * changes neither `history.length` nor the params, so the shared URL writers
 * read this counter to tell an outside navigation from their own lagging
 * `replace`, which never bumps it.
 */
function useNavigationEpoch(): number {
  return useSyncExternalStore(
    subscribeNavigationEpoch,
    readNavigationEpoch,
    readServerNavigationEpoch
  );
}

let navigationEpoch = 0;
const navigationEpochListeners = new Set<() => void>();

function bumpNavigationEpoch() {
  navigationEpoch += 1;
  for (const listener of navigationEpochListeners) {
    listener();
  }
}

function readNavigationEpoch() {
  return navigationEpoch;
}

function readServerNavigationEpoch() {
  return 0;
}

function subscribeNavigationEpoch(listener: () => void) {
  navigationEpochListeners.add(listener);
  if (navigationEpochListeners.size === 1) {
    globalThis.window?.addEventListener("popstate", bumpNavigationEpoch);
  }
  return () => {
    navigationEpochListeners.delete(listener);
    if (navigationEpochListeners.size === 0) {
      globalThis.window?.removeEventListener("popstate", bumpNavigationEpoch);
    }
  };
}

function isPlainNavigationClick(event: MouseEvent<HTMLAnchorElement>) {
  return (
    event.button === 0 &&
    !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
  );
}

function useOrgPathBuilder(): OrgPathBuilder {
  // ISS-10335: ONE source. `useNavOrgSlug` answers the synthetic session's org
  // directly now, so the route-param fallback that used to sit beside this is
  // gone — it could only ever fire under the synthetic session, which is exactly
  // when this is non-empty, and it could not fire at all on an UNSCOPED route,
  // which is where the lane actually needed a slug.
  const orgSlug = useNavOrgSlug();

  return useMemo(
    () => (orgRelativePath: string) =>
      orgSlug ? `/${orgSlug}${orgRelativePath}` : orgRelativePath,
    [orgSlug]
  );
}

/** The `[orgSlug]` layout's Settings parallel slot (ISS-8370 D2). */
export const SETTINGS_PARALLEL_SLOT = "settings";

export type SettingsSlotSegments = {
  /** The `@settings` slot's active segment, or null when it renders nothing. */
  slotSegment: string | null;
  /**
   * Every active segment of the `children` slot below `[orgSlug]`, outermost
   * first — `["settings"]` for `/settings`, `["settings", "compute-targets",
   * "abc"]` for a retained subroute. The whole path, because the first segment
   * alone cannot tell the Settings page from a route beneath it.
   */
  childSegments: readonly string[];
};

/**
 * Which route each of the `[orgSlug]` layout's two slots is showing. Lives here
 * because it is a Next layout-tree question with no port analogue — the
 * parallel slot is a Next construct — and this is the one module allowed to ask
 * `next/navigation` directly.
 */
export function useSettingsSlotSegments(): SettingsSlotSegments {
  return {
    slotSegment: useSelectedLayoutSegment(SETTINGS_PARALLEL_SLOT),
    childSegments: useSelectedLayoutSegments(),
  };
}

function NextAdapterLink({
  href,
  prefetch,
  replace,
  scroll,
  children,
  ref,
  onClick,
  ...anchorProps
}: NavigationLinkProps) {
  return (
    <NextLink
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (isPlainNavigationClick(event)) {
          bumpNavigationEpoch();
        }
      }}
      prefetch={prefetch}
      ref={ref}
      replace={replace}
      scroll={scroll}
      {...anchorProps}
    >
      {children}
    </NextLink>
  );
}
