import languine from "@repo/internationalization/languine.json" with {
  type: "json",
};

/** Mirror rewriteDefault without importing the server-only i18n barrel. */
export function publicPathname(pathname: string): string {
  const prefix = `/${languine.locale.source}`;
  if (pathname === prefix) {
    return "/";
  }
  return pathname.startsWith(`${prefix}/`)
    ? pathname.slice(prefix.length)
    : pathname;
}
