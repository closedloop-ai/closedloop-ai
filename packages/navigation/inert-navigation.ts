import type {
  NavigationActions,
  OrgPathBuilder,
  ReadonlySearchParams,
  RouteParams,
} from "./navigation-adapter";

/**
 * Stand-ins for a tree mounted with no navigation provider (Storybook, unit
 * mounts, the provider-free desktop guard). A hook selects one of these in place
 * of the adapter's own `use*` member once per mount, so each is module-level and
 * referentially stable: that is what keeps the caller's hook order fixed.
 */
export const INERT_NAVIGATION: NavigationActions = {
  navigate: () => undefined,
  replace: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
};

export function useNoPath(): string {
  return "";
}

export function useNoSearchParams(): ReadonlySearchParams {
  return NO_SEARCH_PARAMS;
}

export function useNoNavigationEpoch(): number | null {
  return null;
}

export function useNoRouteParams(): RouteParams {
  return NO_ROUTE_PARAMS;
}

export function useInertNavigation(): NavigationActions {
  return INERT_NAVIGATION;
}

export function useIdentityOrgPath(): OrgPathBuilder {
  return IDENTITY_ORG_PATH;
}

const NO_SEARCH_PARAMS: ReadonlySearchParams = new URLSearchParams();
const NO_ROUTE_PARAMS: RouteParams = {};
const IDENTITY_ORG_PATH: OrgPathBuilder = (orgRelativePath) => orgRelativePath;
