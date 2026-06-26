const INSIGHTS_ROUTE_SEGMENT_RE = /\/insights(?:\/|$)/;

export function shouldRunAmbientDesktopBootstrap(
  pathname: string | null | undefined
): boolean {
  if (!pathname) {
    return true;
  }

  return !INSIGHTS_ROUTE_SEGMENT_RE.test(pathname);
}
