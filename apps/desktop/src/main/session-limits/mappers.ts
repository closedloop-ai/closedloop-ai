/**
 * @file mappers.ts
 * @description Pure helpers that map the two upstream rate-limit shapes into the
 * renderer's {@link SessionLimitsSnapshot} (PRD-539, FEA-3493).
 *
 * Two sources feed the snapshot store:
 *  - the interactive statusline `rate_limits` object — RICH, continuous
 *    per-window `used_percentage` (already 0–100) + epoch `resets_at`;
 *  - the non-interactive `rate_limit_event` (`SDKRateLimitInfo`) — COARSE:
 *    `status` / `resetsAt` / `type`, with no continuous percentage.
 *
 * Both mappers accept `unknown` and narrow defensively (mirroring
 * {@link file://./utilization.ts mapUtilizationResponse}): an unexpected field
 * simply yields `null` rather than throwing, so a shape drift upstream degrades
 * to a hidden window instead of crashing the main process.
 */
import { clampPercent } from "@repo/api/src/utils/math";
import type {
  RateLimitSnapshot,
  SessionLimitsSnapshot,
} from "../../shared/session-limits-channel.js";
import type { RateLimitEventSnapshot } from "../cost/token-usage.js";
import {
  epochSecondsToIso,
  narrowRateLimitPayload,
} from "./rate-limit-narrow.js";

/** Windows on {@link SessionLimitsSnapshot} that carry a {@link RateLimitSnapshot}. */
type RateLimitWindowKey =
  | "fiveHour"
  | "sevenDay"
  | "sevenDayOpus"
  | "sevenDaySonnet";

/** An all-null snapshot stamped with `fetchedAt`; individual windows overlay it. */
function emptySnapshot(fetchedAt: string): SessionLimitsSnapshot {
  return {
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    extraUsage: null,
    fetchedAt,
  };
}

/**
 * Convert an epoch value (seconds since the Unix epoch, as both upstreams emit)
 * into an ISO-8601 string, or null when absent/out-of-range. A non-positive
 * value is treated as "no reset" (a `0` sentinel would otherwise decode to
 * 1970). Never throws.
 */
/**
 * Map one statusline window → snapshot. Two field shapes are observed on the
 * `rate_limits` payload, so both are accepted:
 *  - the per-window keyed shape (`{ used_percentage, resets_at }`), and
 *  - the observed `primary`/`secondary` shape (`{ used_percent, resets_at }`,
 *    e.g. golden session 019ea892 line 17), whose percentage field is
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
 * session 019ea892). Explicit per-window keys take precedence; the positional
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

/**
 * `SDKRateLimitInfo.type` → the window it constrains. The fallback to `fiveHour`
 * in the mappers below is only for an ABSENT/unknown `type` (a coarse event may
 * carry only `status`); every recognized `RateLimitWindowType` the parser can
 * emit is mapped here explicitly so it is never mislabeled. The weekly
 * overage-included variant is a seven-day window, so it maps to `sevenDay`.
 * Pay-as-you-go `overage` has no coarse window bar (it belongs to `extraUsage`,
 * which a coarse event cannot populate) and is intentionally left unmapped rather
 * than mislabeled onto a rate-limit window — see the mappers' handling below.
 */
const COARSE_TYPE_TO_WINDOW: Record<string, RateLimitWindowKey> = {
  five_hour: "fiveHour",
  seven_day: "sevenDay",
  seven_day_opus: "sevenDayOpus",
  seven_day_sonnet: "sevenDaySonnet",
  seven_day_overage_included: "sevenDay",
};

/**
 * Coarse `rateLimitType` values that intentionally map to NO rate-limit window.
 * `overage` is pay-as-you-go credit usage (an `extraUsage` concept), not a
 * session/weekly window; a coarse exhausted event carries no percentage to fill
 * the `extraUsage` shape, so surfacing it would require fabricating one. We keep
 * it unmapped so it never mislabels onto `fiveHour`.
 */
const COARSE_UNWINDOWED_TYPES = new Set<string>(["overage"]);

/**
 * Statuses that mean the window is at its ceiling. A coarse `rate_limit_event`
 * carries no continuous percentage, so it can only be mapped to a bar height
 * when the status itself says "exhausted" (→ 100%). Every other status is left
 * unpopulated rather than fabricating a number (see {@link mapSdkRateLimitInfo}).
 */
const COARSE_EXHAUSTED_STATUSES = new Set(["rejected", "blocked", "exhausted"]);

/**
 * Map a `rate_limit_event` `SDKRateLimitInfo` into a COARSE snapshot. The event
 * carries `status`, an epoch `resetsAt`, and a `type` selecting the window, but
 * no continuous percentage.
 *
 * We only populate a window when the status reports the window is exhausted
 * (→ 100% + reset). For any other status we return an all-null snapshot: the
 * event has no percentage to draw a bar from, and inventing one (e.g. treating a
 * warn-threshold as usage, or drawing an empty 0% gauge) would both mislead the
 * user and force the session-limit UI to mount when it should stay hidden. In
 * that case reconciliation falls back to a richer/older sample or hides the UI.
 */
export function mapSdkRateLimitInfo(
  info: unknown,
  fetchedAt: string
): SessionLimitsSnapshot {
  const snapshot = emptySnapshot(fetchedAt);
  if (!info || typeof info !== "object") {
    return snapshot;
  }
  const v = info as Record<string, unknown>;
  const status = typeof v.status === "string" ? v.status : null;
  if (!(status && COARSE_EXHAUSTED_STATUSES.has(status))) {
    return snapshot;
  }
  const type = typeof v.type === "string" ? v.type : null;
  // A recognized-but-unwindowed type (e.g. `overage`) draws no bar rather than
  // mislabeling onto fiveHour; only an ABSENT/unknown type defaults to fiveHour.
  if (type && COARSE_UNWINDOWED_TYPES.has(type)) {
    return snapshot;
  }
  const window: RateLimitWindowKey =
    (type ? COARSE_TYPE_TO_WINDOW[type] : undefined) ?? "fiveHour";
  // Accept camelCase (SDK) and snake_case (raw event) reset fields.
  snapshot[window] = {
    utilization: 100,
    resetsAt: epochSecondsToIso(v.resetsAt ?? v.resets_at ?? v.reset),
  };
  return snapshot;
}

/**
 * Map an already-parsed {@link RateLimitEventSnapshot} (from
 * {@link file://../cost/token-usage.ts parseRateLimitEvent}) into a COARSE
 * {@link SessionLimitsSnapshot}.
 *
 * Distinct from {@link mapSdkRateLimitInfo}, which narrows the RAW
 * `rate_limit_info` object (`type`, epoch `resetsAt`): the parsed snapshot has
 * already normalized `rateLimitType` (window) and an ISO `resetsAt`, so this
 * mapper consumes those directly rather than re-narrowing an epoch. It shares
 * the same "only an exhausted status draws a bar" rule so a warning/allowed
 * event populates no window and the UI stays hidden (see
 * {@link COARSE_EXHAUSTED_STATUSES}). Never throws; `null` input → all-null
 * snapshot.
 */
export function mapRateLimitEventSnapshot(
  info: RateLimitEventSnapshot | null,
  fetchedAt: string
): SessionLimitsSnapshot {
  const snapshot = emptySnapshot(fetchedAt);
  if (!(info && COARSE_EXHAUSTED_STATUSES.has(info.status))) {
    return snapshot;
  }
  // A recognized-but-unwindowed type (e.g. `overage`) draws no bar rather than
  // mislabeling onto fiveHour; only a null/unknown type defaults to fiveHour.
  if (info.rateLimitType && COARSE_UNWINDOWED_TYPES.has(info.rateLimitType)) {
    return snapshot;
  }
  const window: RateLimitWindowKey =
    (info.rateLimitType
      ? COARSE_TYPE_TO_WINDOW[info.rateLimitType]
      : undefined) ?? "fiveHour";
  snapshot[window] = {
    utilization: 100,
    // Already ISO-normalized by parseRateLimitEvent (or null).
    resetsAt: info.resetsAt,
  };
  return snapshot;
}
