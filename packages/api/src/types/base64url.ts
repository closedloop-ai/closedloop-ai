/**
 * Dependency-free base64url string codec shared by every surface that needs to
 * carry an ASCII payload through a URL or query param without the fragile `+`,
 * `/`, and `=` characters (padding stripped on encode, restored on decode).
 *
 * Uses only the global `btoa`/`atob`, which exist in the browser, the Next.js
 * runtimes, and the Electron main process (Node), so importing this pulls in no
 * extra runtime dependencies. Callers are responsible for keeping the input
 * within the Latin1 range that `btoa`/`atob` round-trip exactly (ASCII JSON,
 * PEM text, etc.).
 */

const BASE64_PADDING_RE = /=+$/;

/** Encode an ASCII string to an unpadded base64url token. */
export function toBase64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(BASE64_PADDING_RE, "");
}

/**
 * Decode a base64url token produced by {@link toBase64Url}, restoring the
 * stripped padding first. Returns `null` for any malformed value instead of
 * throwing so callers can fall back cleanly.
 */
export function fromBase64Url(value: string): string | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return null;
  }
}
