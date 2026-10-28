import { parsePositiveEnvMs as parseSharedPositiveEnvMs } from "@closedloop-ai/shared-platform/parse-env-ms";
import { log } from "@repo/observability/log";

// Keyless telemetry capacity / back-pressure knobs (FEA-1994 / PRD-481 C6).
// Return undefined when unset/invalid so the ingress module's built-in defaults
// stay the single source of truth (no default duplicated at the call site).
export function parseOptionalBoundedEnvInt(
  name: string,
  min: number
): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    log.warn(`Invalid ${name}, ignoring (using built-in default)`, {
      value: raw,
      min,
    });
    return undefined;
  }
  return value;
}

/**
 * Relay's binding of the shared timer clamp. Identical bounds; the only
 * difference is that the invalid-value warning goes through the structured,
 * Datadog-exported logger rather than bare stderr. The clamp itself is NOT
 * duplicated here — `@closedloop-ai/shared-platform` owns it, and cannot import
 * `@repo/observability/log` because that pulls in the workspace-only
 * `@repo/api` this cross-repo package must stay clear of.
 */
export function parsePositiveEnvMs(name: string, defaultMs: number): number {
  return parseSharedPositiveEnvMs(name, defaultMs, log.warn);
}
