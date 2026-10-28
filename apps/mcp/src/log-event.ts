import { log } from "@repo/observability/log";

/**
 * The `[mcp] <event> k=v k=v` structured diagnostic line every MCP OAuth and
 * session path emits. Split out of `index.ts` (ISS-6322) as the one formatting
 * concern in that module with no server, transport, or database dependency.
 *
 * `undefined` values are dropped rather than rendered, so an absent attribute
 * stays absent from the line instead of appearing as the literal `undefined` —
 * log scrapers keying on `k=` would otherwise match a value that was never set.
 */
export function logMcpEvent(
  event: string,
  details?: Record<string, string | number | boolean | undefined>
): void {
  const payload = details
    ? Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ")
    : "";
  log.info(`[mcp] ${event}${payload ? ` ${payload}` : ""}`);
}
