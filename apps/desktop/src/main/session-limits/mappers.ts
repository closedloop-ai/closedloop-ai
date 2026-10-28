/**
 * @file mappers.ts
 * @description Pure helpers that map the statusline rate-limit shape into the
 * renderer's {@link SessionLimitsSnapshot} (PRD-539, FEA-3493).
 *
 * The interactive statusline `rate_limits` object is RICH: continuous
 * per-window `used_percentage` (already 0–100) + epoch `resets_at`.
 *
 * The mappers accept `unknown` and narrow defensively (mirroring
 * {@link file://./utilization.ts mapUtilizationResponse}): an unexpected field
 * simply yields `null` rather than throwing, so a shape drift upstream degrades
 * to a hidden window instead of crashing the main process.
 */
import { clampPercent } from "@repo/api/src/utils/math";
import type {
  RateLimitSnapshot,
  SessionLimitsSnapshot,
} from "../../shared/session-limits-channel.js";
import {
  epochSecondsToIso,
  narrowRateLimitPayload,
} from "./rate-limit-narrow.js";

/**
 * Map one statusline window → snapshot. Two field shapes are observed on the
 * `rate_limits` payload, so both are accepted:
 *  - the per-window keyed shape (`{ used_percentage, resets_at }`), and
 *  - the observed `primary`/`secondary` shape (`{ used_percent, resets_at }`,
 *    e.g. golden session cc6c71e9 line 17), whose percentage field is
 *    `used_percent`.
 * The first numeric of the two field names wins; the epoch `resets_at` is shared.
 */
function toRateLimitFromPercentage(value: unknown): RateLimitSnapshot | null {
  return narrowRateLimitPayload(
    value,
    (v) => {
      // `used_percentage`/`used_percent` are already 0–100; clamp defensively.
      // The first numeric of the two field names wins.
      let pct: number | null = null;
      if (typeof v.used_percentage === "number") {
        pct = v.used_percentage;
      } else if (typeof v.used_percent === "number") {
        pct = v.used_percent;
      }
      return pct === null ? null : clampPercent(pct);
    },
    (v) => epochSecondsToIso(v.resets_at)
  );
}

/**
 * Map the interactive statusline `rate_limits` object into a RICH snapshot.
 *
 * Two window layouts are observed and both are honored: the per-window keyed
 * layout (`five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`),
 * and the positional `primary` (shortest window → fiveHour) / `secondary`
 * (longer window → sevenDay) layout the harness records today (see golden
 * session cc6c71e9). Explicit per-window keys take precedence; the positional
 * pair only fills a window the keyed layout left null, so a payload carrying
 * both never double-maps. Missing windows stay null. Percentages are passed
 * through (already 0–100, clamped); epoch `resets_at` → ISO.
 */
export function mapStatuslineRateLimits(
  rateLimits: unknown,
  fetchedAt: string
): SessionLimitsSnapshot {
  const d = (rateLimits ?? {}) as Record<string, unknown>;
  return {
    fiveHour:
      toRateLimitFromPercentage(d.five_hour) ??
      toRateLimitFromPercentage(d.primary),
    sevenDay:
      toRateLimitFromPercentage(d.seven_day) ??
      toRateLimitFromPercentage(d.secondary),
    sevenDayOpus: toRateLimitFromPercentage(d.seven_day_opus),
    sevenDaySonnet: toRateLimitFromPercentage(d.seven_day_sonnet),
    extraUsage: null,
    fetchedAt,
  };
}

/**
 * Narrow one window off the on-disk statusline snapshot file
 * (`statusline-snapshot.json`, written by `statusline-capture.js`). That file is
 * ALREADY in the mapped camelCase shape (`{ utilization, resetsAt }` — an ISO
 * `resetsAt`), unlike the raw `rate_limits` payload {@link
 * mapStatuslineRateLimits} consumes. The percentage is clamped defensively and
 * an already-ISO `resetsAt` is passed through (a non-string → null). Never
 * throws; a non-object/absent window → null.
 */
function toRateLimitFromStatuslineFile(
  value: unknown
): RateLimitSnapshot | null {
  return narrowRateLimitPayload(
    value,
    (v) =>
      typeof v.utilization === "number" ? clampPercent(v.utilization) : null,
    (v) =>
      typeof v.resetsAt === "string" && v.resetsAt.length > 0
        ? v.resetsAt
        : null
  );
}

/**
 * Map the on-disk statusline snapshot file into a RICH
 * {@link SessionLimitsSnapshot} for the store (FEA-3523).
 *
 * The install script (`statusline-capture.js`) writes the file in the
 * near-final camelCase shape `{ fiveHour, sevenDay, totalCostUsd, fetchedAt }`
 * — NOT the raw `rate_limits` payload {@link mapStatuslineRateLimits} narrows.
 * This mapper consumes that file shape directly: it carries only the 5-hour and
 * weekly windows (the script does not emit per-model Opus/Sonnet or extra
 * usage). The file's own `fetchedAt` is preferred when it is a valid string, so
 * the store's freshness and the displayed timestamp reflect the actual capture;
 * a missing/invalid one falls back to the caller-supplied `fetchedAt`. Never
 * throws; a non-object payload yields an all-null snapshot.
 */
export function mapStatuslineSnapshotFile(
  fileSnapshot: unknown,
  fetchedAt: string
): SessionLimitsSnapshot {
  const d =
    fileSnapshot && typeof fileSnapshot === "object"
      ? (fileSnapshot as Record<string, unknown>)
      : {};
  // Prefer the file's own `fetchedAt` only when it is a PARSEABLE ISO string;
  // a non-empty but unparseable value (e.g. "not-a-date") falls back to the
  // caller-supplied `fetchedAt`, which statusline-reader already resolves from a
  // valid `fetchedAt`/mtime/now chain. This keeps the displayed timestamp and the
  // store's freshness ordering consistent with the resolved capture time.
  const capturedAt =
    typeof d.fetchedAt === "string" && Number.isFinite(Date.parse(d.fetchedAt))
      ? d.fetchedAt
      : fetchedAt;
  return {
    fiveHour: toRateLimitFromStatuslineFile(d.fiveHour),
    sevenDay: toRateLimitFromStatuslineFile(d.sevenDay),
    sevenDayOpus: null,
    sevenDaySonnet: null,
    extraUsage: null,
    fetchedAt: capturedAt,
  };
}
