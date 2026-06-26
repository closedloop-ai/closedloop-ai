export const CURRENT_DESKTOP_API_NAMESPACE = "gateway";

export type DesktopApiNamespace = typeof CURRENT_DESKTOP_API_NAMESPACE;

export const DESKTOP_API_NAMESPACE_CAPABILITY_KEY = "desktopApiNamespace";

export const DESKTOP_API_PREFIX = "/api/gateway/";

export function isDesktopApiNamespace(
  value: unknown
): value is DesktopApiNamespace {
  return value === CURRENT_DESKTOP_API_NAMESPACE;
}

export function isDesktopApiPath(pathname: string): boolean {
  return pathname.startsWith(DESKTOP_API_PREFIX);
}

// Identity function: supported desktop API paths are already in the current
// namespace. The namespace parameter is kept for call-site compatibility while
// stale legacy namespace fields are removed from callers.
export function rewriteDesktopApiPath(
  pathname: string,
  _namespace: string
): string {
  return pathname;
}

export function getDesktopApiNamespaceFromCapabilities(
  capabilities: Record<string, unknown> | null | undefined
): DesktopApiNamespace | null {
  if (!capabilities) {
    return null;
  }
  const raw = capabilities[DESKTOP_API_NAMESPACE_CAPABILITY_KEY];
  return isDesktopApiNamespace(raw) ? raw : null;
}

// withDesktopApiNamespaceCapability is now a delete-only operation.
// Reading a legacy 'engineer' capability from a stored record returns null
// intentionally (isDesktopApiNamespace no longer accepts "engineer"), so
// the only reachable path here is the delete branch.
export function withDesktopApiNamespaceCapability(
  capabilities: Record<string, unknown> | null | undefined,
  _namespace: string | null
): Record<string, unknown> {
  const next = { ...(capabilities ?? {}) };
  delete next[DESKTOP_API_NAMESPACE_CAPABILITY_KEY];
  return next;
}
