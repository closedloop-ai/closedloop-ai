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
} from "next/navigation";
import { type ReactNode, useMemo } from "react";

/**
 * The sandbox's implementation of the navigation port. A portable `@repo/app`
 * surface reaches its host's router only through this seam, and a prototype
 * route that renders one must mount the provider below — the in-memory adapter
 * is not a substitute here, because these routes really do navigate (a project
 * row opens `/p/web-master/projects/<id>`) and a memory adapter would swallow
 * that.
 *
 * This is the ONLY module in apps/prototypes that may import next/navigation or
 * next/link for navigation purposes. There is no org slug in the sandbox, so
 * the org-path builder returns its argument unchanged.
 */
export const prototypeNavigationAdapter: NavigationAdapter = {
  Link: PrototypeAdapterLink,
  useNavigationActions,
  useOrgPathBuilder,
  usePathValue,
  useRouteParamsValue,
  useSearchParamsSnapshot,
};

/** Mounts the navigation port for a prototype subtree. */
export function PrototypeNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <NavigationProvider adapter={prototypeNavigationAdapter}>
      {children}
    </NavigationProvider>
  );
}

function useNavigationActions(): NavigationActions {
  const router = useRouter();
  return useMemo(
    () => ({
      back: () => router.back(),
      forward: () => router.forward(),
      navigate: (href, options) => router.push(href, options),
      refresh: () => router.refresh(),
      replace: (href, options) => router.replace(href, options),
    }),
    [router]
  );
}

function usePathValue(): string {
  return usePathname();
}

function useRouteParamsValue(): RouteParams {
  return useParams();
}

function useSearchParamsSnapshot(): URLSearchParams {
  return useSearchParams();
}

function useOrgPathBuilder(): OrgPathBuilder {
  return identityOrgPath;
}

function identityOrgPath(orgRelativePath: string): string {
  return orgRelativePath;
}

function PrototypeAdapterLink({
  children,
  href,
  prefetch,
  ref,
  replace,
  scroll,
  ...anchorProps
}: NavigationLinkProps) {
  return (
    <NextLink
      href={href}
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
