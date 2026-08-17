import {
  DEFAULT_SESSION_QUALITY,
  SESSION_QUALITY_VALUES,
  type SessionQuality,
} from "@repo/api/src/agent-session-filters";

/**
 * FEA-4145: coerce an untyped request `quality` to a known `SessionQuality`.
 * Unknown/absent values fall back to the fail-open `DEFAULT_SESSION_QUALITY`
 * (`all`) — the desktop sanitizer validates raw values leniently; the cloud zod
 * route validator is the seam that hard-rejects an unsupported value.
 *
 * Extracted from `shared-agent-sessions-api.ts` (a shrink-only grandfathered
 * file) so the quality sanitizer lives in its own lightweight module.
 */
export function coerceSessionQuality(value: unknown): SessionQuality {
  return SESSION_QUALITY_VALUES.includes(value as SessionQuality)
    ? (value as SessionQuality)
    : DEFAULT_SESSION_QUALITY;
}
