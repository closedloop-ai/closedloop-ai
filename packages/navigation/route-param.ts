import type { RouteParams } from "./navigation-adapter";

/**
 * Returns the named route param when it is a plain string, else "".
 *
 * `useRouteParams()` values are `string | string[] | undefined` (catch-all
 * segments yield arrays; the key may be absent outside its route). Callers
 * that expect a single dynamic segment should narrow through this helper
 * instead of casting.
 */
export function getStringRouteParam(params: RouteParams, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}
