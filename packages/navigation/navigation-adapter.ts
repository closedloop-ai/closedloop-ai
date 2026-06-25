import type {
  AnchorHTMLAttributes,
  ComponentType,
  ReactNode,
  Ref,
} from "react";

/**
 * Options accepted by imperative navigations. Mirrors the subset of
 * next/navigation router options the app actually uses; surface adapters may
 * ignore options that do not apply (e.g. `scroll` in a non-URL shell).
 */
export type NavigateOptions = {
  scroll?: boolean;
};

/**
 * Imperative navigation actions exposed by `useNavigation()`.
 *
 * `refresh` re-synchronizes the current view with server state (web: Next
 * router refresh; other shells re-fetch as appropriate).
 */
export type NavigationActions = {
  navigate: (href: string, options?: NavigateOptions) => void;
  replace: (href: string, options?: NavigateOptions) => void;
  back: () => void;
  refresh: () => void;
};

export type RouteParams = Record<string, string | string[] | undefined>;

/**
 * Builds an in-app href for a resource scoped to the active organization.
 * The argument is the org-relative path, always starting with "/" (e.g.
 * "/users/123"); the return value is the full href to navigate to.
 *
 * This is a *routing* seam, deliberately separate from the auth identity port:
 * the org slug is a web-URL concern, not part of a shell's auth snapshot. The
 * web adapter prefixes the active org slug ("/acme/users/123").
 *
 * Scope: this is a path-string abstraction — org-relative path hrefs
 * ("/users/:id") are the cross-surface route language of the port (FEA-1518
 * decision). The web adapter prefixes the active org slug; the desktop
 * renderer's adapter consumes the same hrefs without a router (FEA-1497:
 * nav-stack over react-router), mapping them to renderer views through its
 * route table and returning them unchanged from this builder (a shell with
 * no URL-visible org).
 *
 * Implementations MUST NOT emit a protocol-relative path: when no slug is
 * available (e.g. mid-hydration) the web adapter returns the org-relative path
 * unchanged ("/users/123"), never "//users/123".
 */
export type OrgPathBuilder = (orgRelativePath: string) => string;

/**
 * Read-only view of the current search params. Next's useSearchParams()
 * returns a ReadonlyURLSearchParams whose mutating methods throw at runtime;
 * the port strips them at the type level so the compiler enforces what the
 * web runtime already enforces. Writes go through NavigationActions.
 */
export type ReadonlySearchParams = Omit<
  URLSearchParams,
  "append" | "delete" | "set" | "sort"
>;

/**
 * Props for the port `Link` component. Must render a real anchor so
 * middle-click, Cmd/Ctrl+click, and context-menu behaviors keep working —
 * never an onClick-only navigation.
 */
export type NavigationLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  href: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
};

/**
 * Surface adapter contract. Each app supplies one implementation at its
 * composition root (web: next/navigation + next/link; desktop: its own
 * view-routing; tests: the memory adapter).
 *
 * Adapter members named `use*` are React hooks and must be implemented as
 * such; the provider requires the adapter object itself to be referentially
 * stable for the lifetime of the React tree.
 */
export type NavigationAdapter = {
  useNavigationActions: () => NavigationActions;
  usePathValue: () => string;
  useRouteParamsValue: () => RouteParams;
  useSearchParamsSnapshot: () => ReadonlySearchParams;
  useOrgPathBuilder: () => OrgPathBuilder;
  Link: ComponentType<NavigationLinkProps>;
};
