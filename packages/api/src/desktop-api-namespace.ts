export const CURRENT_DESKTOP_API_NAMESPACE = "gateway";
export const LEGACY_DESKTOP_API_NAMESPACE = "engineer";

export type DesktopApiNamespace =
  | typeof CURRENT_DESKTOP_API_NAMESPACE
  | typeof LEGACY_DESKTOP_API_NAMESPACE;

export const DESKTOP_API_NAMESPACE_CAPABILITY_KEY = "desktopApiNamespace";

const DESKTOP_API_PREFIXES: Record<DesktopApiNamespace, string> = {
  [CURRENT_DESKTOP_API_NAMESPACE]: "/api/gateway/",
  [LEGACY_DESKTOP_API_NAMESPACE]: "/api/engineer/",
};

export function isDesktopApiNamespace(
  value: unknown
): value is DesktopApiNamespace {
  return (
    value === CURRENT_DESKTOP_API_NAMESPACE ||
    value === LEGACY_DESKTOP_API_NAMESPACE
  );
}

export function getDesktopApiPrefix(namespace: DesktopApiNamespace): string {
  return DESKTOP_API_PREFIXES[namespace];
}

export function detectDesktopApiNamespace(
  pathname: string
): DesktopApiNamespace | null {
  if (pathname.startsWith(getDesktopApiPrefix(CURRENT_DESKTOP_API_NAMESPACE))) {
    return CURRENT_DESKTOP_API_NAMESPACE;
  }
  if (pathname.startsWith(getDesktopApiPrefix(LEGACY_DESKTOP_API_NAMESPACE))) {
    return LEGACY_DESKTOP_API_NAMESPACE;
  }
  return null;
}

export function isDesktopApiPath(pathname: string): boolean {
  return detectDesktopApiNamespace(pathname) !== null;
}

export function rewriteDesktopApiPath(
  pathname: string,
  namespace: DesktopApiNamespace
): string {
  const detectedNamespace = detectDesktopApiNamespace(pathname);
  if (!detectedNamespace || detectedNamespace === namespace) {
    return pathname;
  }
  return pathname.replace(
    getDesktopApiPrefix(detectedNamespace),
    getDesktopApiPrefix(namespace)
  );
}

export function normalizeDesktopApiPath(pathname: string): string | null {
  if (!isDesktopApiPath(pathname)) {
    return null;
  }
  return rewriteDesktopApiPath(pathname, CURRENT_DESKTOP_API_NAMESPACE);
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

export function withDesktopApiNamespaceCapability(
  capabilities: Record<string, unknown> | null | undefined,
  namespace: DesktopApiNamespace | null
): Record<string, unknown> {
  const next = { ...(capabilities ?? {}) };
  if (namespace === null || namespace === CURRENT_DESKTOP_API_NAMESPACE) {
    delete next[DESKTOP_API_NAMESPACE_CAPABILITY_KEY];
    return next;
  }

  next[DESKTOP_API_NAMESPACE_CAPABILITY_KEY] = namespace;
  return next;
}
