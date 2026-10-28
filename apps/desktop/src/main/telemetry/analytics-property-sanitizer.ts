import {
  DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH,
  DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS,
  DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS,
  DESKTOP_ANALYTICS_STRING_MAX_LENGTH,
} from "@repo/api/src/types/desktop-analytics";

/**
 * Shape product-analytics properties to what the cloud accepts, so a single
 * oversized or non-finite value truncates/nulls instead of costing the whole
 * event: the server rejects an entire event on a string over
 * DESKTOP_ANALYTICS_STRING_MAX_LENGTH or a NaN/Infinity number (e.g. a
 * time_to_resolve_ms computed from a missing/malformed createdAt), and
 * `undefined` is not a JSON value at all. A string array (the ISS-10502
 * list properties) is clamped element-by-element and capped at
 * DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS; non-string elements are dropped rather
 * than coerced, because a fabricated element would read as a measured value.
 */
export function sanitizeAnalyticsProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, DESKTOP_ANALYTICS_STRING_MAX_LENGTH);
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      sanitized[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      // Only the declared array keys may carry an array; anywhere else the
      // relay refuses the WHOLE event (`property_array_invalid`), so shaping
      // it would defeat this function's purpose — drop the property instead.
      if (DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS.has(key)) {
        // The tighter ARRAY element cap, not the scalar one: at 512/element,
        // the three fully-clamped 24-item arrays alone (~36 KiB) would blow
        // the relay's 8 KiB whole-payload gate — the caps must COMPOSE with it.
        sanitized[key] = value
          .filter((element): element is string => typeof element === "string")
          .slice(0, DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS)
          .map((element) =>
            element.slice(0, DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH)
          );
      }
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
