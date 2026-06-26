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

function isLoopbackHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.username === "" &&
    url.password === "" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}
