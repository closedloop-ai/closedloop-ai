import { SETTINGS_ROUTE } from "@repo/api/src/types/settings-panel";

/**
 * The request header Next's App Router sends on a soft navigation, naming the
 * page the navigation starts from. The server matches interception rewrites
 * against it. Next's own header, so spelled as Next spells it.
 */
const NEXT_URL_HEADER = "next-url";

/**
 * ISS-10323: the request headers to forward when a soft navigation starts on the
 * full Settings page and targets it again, with `Next-Url` removed; `null` for
 * every other request.
 *
 * `@settings/(.)settings` intercepts `/{orgSlug}/settings` from every page under
 * the org, the full Settings page included. Intercepted, the full page is kept
 * as the `children` slot, and a retried navigation refetches that slot from its
 * own URL with the same `Next-Url`, which is intercepted again and never fills
 * it. Next 16.3 reloads the document after a second mismatch in a row. Without
 * `Next-Url` the server renders the full page with the new query, and the rail
 * stays mounted.
 */
export function withoutSettingsSelfInterception(
  pathname: string,
  headers: Headers
): Headers | null {
  if (
    headers.get(NEXT_URL_HEADER) !== pathname ||
    !isOrgSettingsPath(pathname)
  ) {
    return null;
  }
  const forwarded = new Headers(headers);
  forwarded.delete(NEXT_URL_HEADER);
  return forwarded;
}

/** Exactly `/{orgSlug}/settings`, the one path `(.)settings` intercepts. */
function isOrgSettingsPath(pathname: string): boolean {
  const [empty, orgSlug, ...rest] = pathname.split("/");
  return (
    empty === "" && Boolean(orgSlug) && `/${rest.join("/")}` === SETTINGS_ROUTE
  );
}
