/**
 * @file utilization.ts
 * @description Desktop-main mapper for the subscription session-limit UI
 * (PRD-538): turns the `/usage` payload's snake_case shape into the renderer's
 * camelCase {@link SessionLimitsSnapshot}.
 *
 * ── SECURITY BOUNDARY: what changed, and on whose authority ───────────────────
 * This file previously carried a hard rule that the desktop must NEVER read the
 * user's OAuth credential, on the reasoning that the installed CLI exposed no
 * headless usage output and therefore no sanctioned data source existed. Both
 * halves of that are now superseded, deliberately and on the record — this is
 * NOT a silently relaxed boundary:
 *
 *   - PRD-538 (APPROVED) requirement R5 / ISS-5353 explicitly scopes "call the
 *     same authenticated usage endpoint Claude Code uses, reusing the installed
 *     CLI's existing credential", and frames the residual risk as "only which
 *     local credential source to read" — i.e. it sanctions reading one.
 *   - The premise that no endpoint existed was simply wrong: the shipped CLI
 *     issues `GET https://api.anthropic.com/api/oauth/usage`. There is a
 *     sanctioned source; it just is not a subprocess.
 *
 * What remains forbidden is unchanged and narrower than before:
 *   - the macOS Keychain SECRET is still never read (`security … -w` raises a
 *     user-facing ACL prompt, which PRD-538 forbids);
 *   - the credential is never logged, never persisted, never placed in an error
 *     payload, and never crosses IPC.
 * The single sanctioned read, and the full rationale for choosing it over the
 * other two credential locations, lives in
 * {@link file://./usage-credential.ts usage-credential.ts}. The network call
 * lives in {@link file://./usage-api-client.ts usage-api-client.ts}. This module
 * stays a pure mapper and touches neither.
 */
import type {
  RateLimitSnapshot,
  SessionLimitsSnapshot,
} from "../../shared/session-limits-channel.js";
import {
  epochSecondsToIso,
  narrowRateLimitPayload,
} from "./rate-limit-narrow.js";

/**
 * Normalize a window's `resets_at`, which the endpoint expresses as an ISO
 * string on some windows and epoch SECONDS on others (the shipped CLI branches
 * on `typeof resets_at === "number"` before formatting it). Anything else — a
 * null, a missing field, an unparseable value — yields null, which the renderer
 * shows as "no scheduled reset" rather than inventing a time.
 */
function toResetsAt(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return epochSecondsToIso(value);
}

function toRateLimit(value: unknown): RateLimitSnapshot | null {
  return narrowRateLimitPayload(
    value,
    (v) => (typeof v.utilization === "number" ? v.utilization : null),
    (v) => toResetsAt(v.resets_at)
  );
}

/**
 * Map a `/usage` payload's snake_case shape into the renderer's camelCase
 * snapshot. Pure, with an injected `fetchedAt` so the capture time is explicit
 * and testable — that timestamp is what lets the renderer tell a fresh snapshot
 * from a stale one, so it is always stamped and never omitted.
 *
 * A window that is absent, null, or carries no numeric utilization maps to
 * `null` (UNKNOWN), never to `0`. The distinction matters: a genuine 0% is a
 * real, renderable value, while a missing window must not draw an empty bar
 * implying the user has consumed nothing.
 */
export function mapUtilizationResponse(
  json: unknown,
  fetchedAt: string
): SessionLimitsSnapshot {
  const d = (json ?? {}) as Record<string, unknown>;
  const extraRaw = d.extra_usage as Record<string, unknown> | undefined | null;
  const extraUsage = extraRaw
    ? {
        isEnabled: extraRaw.is_enabled === true,
        monthlyLimitUsd:
          typeof extraRaw.monthly_limit === "number"
            ? extraRaw.monthly_limit / 100
            : null,
        usedCreditsUsd:
          typeof extraRaw.used_credits === "number"
            ? extraRaw.used_credits / 100
            : null,
        utilization:
          typeof extraRaw.utilization === "number"
            ? extraRaw.utilization
            : null,
      }
    : null;

  return {
    fiveHour: toRateLimit(d.five_hour),
    sevenDay: toRateLimit(d.seven_day),
    sevenDayOpus: toRateLimit(d.seven_day_opus),
    sevenDaySonnet: toRateLimit(d.seven_day_sonnet),
    extraUsage,
    fetchedAt,
  };
}
