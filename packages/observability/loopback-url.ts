const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Whether `url` names an HTTP(S) listener in this process's own network
 * namespace: on ECS, the task's collector sidecar (ISS-11827). Such a listener
 * holds the Datadog key and authenticates the export itself, so the caller
 * needs none. Any other scheme, or credentials in the URL, is refused: fetch
 * rejects both before sending, so the export path would only look open.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      HTTP_PROTOCOLS.has(parsed.protocol) &&
      parsed.username === "" &&
      parsed.password === "" &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}
