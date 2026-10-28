/**
 * `undefined` when the browser cannot report a zone, which leaves the caller on
 * the server's UTC bucketing — so daily buckets are UTC days, not local ones.
 */
export function resolveBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
