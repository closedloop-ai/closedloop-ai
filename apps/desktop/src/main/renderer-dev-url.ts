export const RendererDevServerArg = {
  Prefix: "--closedloop-renderer-url=",
} as const;

/**
 * Resolve the optional renderer URL used by the local Desktop dev launcher.
 *
 * Packaged builds ignore the argument entirely, and local builds only accept
 * loopback HTTP URLs served by Vite.
 */
export function resolveDevRendererUrl(
  argv: readonly string[],
  options: { isPackaged: boolean }
): string | null {
  if (options.isPackaged) {
    return null;
  }

  const arg = argv.find((value) =>
    value.startsWith(RendererDevServerArg.Prefix)
  );
  if (!arg) {
    return null;
  }

  const rawUrl = arg.slice(RendererDevServerArg.Prefix.length);
  try {
    const parsed = new URL(rawUrl);
    if (isLoopbackHttpUrl(parsed)) {
      return parsed.href;
    }
  } catch {
    return null;
  }

  return null;
}

export function isLoopbackHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.username === "" &&
    url.password === "" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}

/**
 * Compute the `Access-Control-Allow-Origin` value for a renderer `fetch()` of a
 * prepared `app://` transcript, given the request's `Origin` header (or null).
 *
 * The `app://` scheme is registered `corsEnabled` (startup.ts) so the renderer
 * can fetch transcripts cross-origin from the loopback Vite dev origin. Chromium
 * then requires the response to echo that origin back. We reflect the request
 * `Origin` ONLY when it is a bare loopback HTTP origin — the exact same
 * constraint {@link resolveDevRendererUrl} enforces on the dev renderer URL — so
 * no remote/arbitrary origin is ever allowed. In packaged builds the renderer
 * document itself is served from `app://`, so the fetch is same-origin and
 * carries no `Origin` header; we return null (no ACAO header needed, and none is
 * granted). This never returns `*`.
 */
export function resolveTranscriptAllowedOrigin(
  requestOrigin: string | null
): string | null {
  if (!requestOrigin) {
    return null;
  }
  try {
    const parsed = new URL(requestOrigin);
    if (isLoopbackHttpUrl(parsed)) {
      // `origin` normalizes to scheme://host[:port] with no trailing slash —
      // exactly the ACAO grammar.
      return parsed.origin;
    }
  } catch {
    return null;
  }
  return null;
}
