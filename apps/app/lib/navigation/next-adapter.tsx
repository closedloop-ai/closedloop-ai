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
import { useOrgSlug } from "@/hooks/use-org-slug";

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
      navigate: (href, options) => router.push(href, options),
      replace: (href, options) => router.replace(href, options),
      back: () => router.back(),
      refresh: () => router.refresh(),
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
  // useOrgSlug is web-only routing (route param + Clerk fallback) and stays in
  // apps/app; the port keeps the slug out of @repo/app. Guard the empty-slug
  // (hydrating) case so the builder never emits a protocol-relative "//…".
  const orgSlug = useOrgSlug();
  return useMemo(
    () => (orgRelativePath: string) =>
      orgSlug ? `/${orgSlug}${orgRelativePath}` : orgRelativePath,
    [orgSlug]
  );
}

function NextAdapterLink({
  href,
  prefetch,
  replace,
  scroll,
  children,
  ref,
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
