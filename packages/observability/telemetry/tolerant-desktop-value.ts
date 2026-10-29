/**
 * @file tolerant-desktop-value.ts
 * @description The version-skew tolerance used by every bounded desktop
 * diagnostics field: an unrecognised wire string folds to the vocabulary's own
 * `Unknown` member rather than failing the whole event, and an over-long
 * free-text string is clamped to its head rather than failing it (ISS-7488).
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { z } from "zod";

function objectValues<T extends Record<string, string>>(values: T) {
  return new Set(Object.values(values));
}

/**
 * Preserve desktop-originated telemetry across version skew by mapping newer
 * wire strings to a bounded generic value instead of rejecting the whole event.
 * Non-string values remain invalid.
 */
export function tolerantDesktopTelemetryValue<
  T extends { Unknown: string } & Record<string, string>,
>(values: T) {
  const knownValues = objectValues(values);
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }
    return knownValues.has(value) ? value : values.Unknown;
  }, z.enum(values));
}

/**
 * ISS-7488 — the marker a truncated diagnostics string ends with.
 *
 * Emitted ONLY when content was actually dropped, so its presence is the signal:
 * `@diagnostics.desktopUpdate.error:*[truncated]` is the query, and a string
 * that fitted carries no marker to make it look otherwise. Same discipline the
 * redaction helpers in this package already follow.
 */
export const DESKTOP_TELEMETRY_TRUNCATION_MARKER = "[truncated]";

/**
 * ISS-7488 — a free-text desktop diagnostics string that CLAMPS instead of
 * rejecting.
 *
 * A length cap on a field like `desktopUpdate.error` is a payload bound, not a
 * correctness property: the desktop composes that string from whatever the
 * updater threw, so nothing upstream holds it to any length. Under `z.string()
 * .max(n)` one long stack trace failed the whole event as
 * `telemetry.validation_failed` and took every other diagnostic on the payload
 * with it — 7 of the 33 rejections measured over the 30 days to 2026-09-14.
 *
 * The head is what diagnoses: an error's class and message lead, and the frames
 * that get dropped are the ones furthest from the throw. A truncated error is
 * still readable; an absent payload is not.
 *
 * `maxChars` bounds the EMITTED value, marker included, so the field can never
 * exceed the cap this replaces.
 */
export function clampedDesktopTelemetryString(maxChars: number) {
  const headChars = maxChars - DESKTOP_TELEMETRY_TRUNCATION_MARKER.length;
  return z.preprocess((value) => {
    if (typeof value !== "string" || value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, headChars)}${DESKTOP_TELEMETRY_TRUNCATION_MARKER}`;
  }, z.string().max(maxChars));
}
