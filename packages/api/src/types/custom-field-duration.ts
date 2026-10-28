/**
 * Parsing and formatting for DURATION-formatted NUMBER custom fields (ISS-7210).
 *
 * **The canonical storage unit is MILLISECONDS.** It is declared alongside
 * `NumberFormat.Duration` in `./custom-field.js` and on the Prisma
 * `NumberFormat` enum; this module is the only place that converts between that
 * unit and a human string, so neither side has to re-derive it.
 *
 * **Named `…CustomFieldDuration…`, not `formatDurationMs`, on purpose.** Two
 * unrelated `formatDurationMs` exports already exist —
 * `packages/app/shared/lib/format-duration-ms.ts` (renders `"1.5s"` / `"999ms"`,
 * em-dash for null) and `packages/lib/sessions/agent-session-projection-utils.ts`
 * — and neither matches this contract: this one caps at two units, carries a day
 * unit, and treats a measured zero as `"0s"` rather than an absence. A third
 * identically-named export would make a call site's behaviour unguessable from
 * its import name, so these carry the custom-field qualifier. Do not "unify"
 * them without deciding which rendering each caller actually wants.
 *
 * Dependency-free on purpose (no Zod, no runtime imports): the value editor is a
 * bundle-sensitive client surface and imports the same functions the server
 * formats with, so the two can never drift.
 */

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Ordered largest-first; format walks it and the parser resolves suffixes off it. */
const DURATION_UNITS = [
  { suffix: "d", ms: MS_PER_DAY },
  { suffix: "h", ms: MS_PER_HOUR },
  { suffix: "m", ms: MS_PER_MINUTE },
  { suffix: "s", ms: MS_PER_SECOND },
  { suffix: "ms", ms: 1 },
] as const;

/**
 * How many non-zero units a rendered duration shows. Two keeps "1h 12m" and
 * "3d 4h" readable at column width without inventing a precision the source
 * measurement does not have.
 */
const DURATION_DISPLAY_UNITS = 2;

const DURATION_TOKEN_REGEX = /^(\d+(?:\.\d+)?)(d|h|m|s|ms)$/;
const BARE_NUMBER_REGEX = /^\d+(?:\.\d+)?$/;
const WHITESPACE_REGEX = /\s+/;

/**
 * Renders a valid millisecond duration as an elapsed span.
 *
 * A measured `0` renders `"0s"`, and so does anything under half a second: an
 * instantaneous span is a fact, and collapsing it into the empty string would
 * make it indistinguishable from a field that was never measured.
 *
 * PRECONDITION: `ms` satisfies {@link isValidCustomFieldDurationMs}. Absence and
 * corruption are the CALLER's to tell apart — this function cannot render either
 * without inventing copy, and returning `""` for both is exactly the collapse
 * above. `computeDisplayValue` returns `""` for an unset value before it reaches
 * here, and falls back to plain number formatting for a corrupt row so the bad
 * value stays visible.
 */
export function formatCustomFieldDurationMs(ms: number): string {
  if (!isValidCustomFieldDurationMs(ms)) {
    return "";
  }

  const parts: string[] = [];
  let remaining = Math.round(ms / MS_PER_SECOND) * MS_PER_SECOND;

  for (const unit of DURATION_UNITS) {
    if (parts.length === DURATION_DISPLAY_UNITS || unit.ms < MS_PER_SECOND) {
      break;
    }
    const count = Math.floor(remaining / unit.ms);
    if (count > 0) {
      parts.push(`${count}${unit.suffix}`);
      remaining -= count * unit.ms;
    }
  }

  return parts.length > 0 ? parts.join(" ") : "0s";
}

/**
 * Parses a human duration ("1h 12m", "18m", "3d 4h", "250ms", "90") into whole
 * milliseconds. Returns `null` when the input is not a duration at all, so the
 * caller can tell "unparseable" from a legitimate `0`.
 *
 * A bare number is read as SECONDS: the unsuffixed case is what a user types
 * when they mean "90 seconds", never "90 milliseconds".
 */
export function parseCustomFieldDurationMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }

  if (BARE_NUMBER_REGEX.test(trimmed)) {
    return asStorableDuration(Number(trimmed) * MS_PER_SECOND);
  }

  let total = 0;
  for (const token of trimmed.split(WHITESPACE_REGEX)) {
    const match = DURATION_TOKEN_REGEX.exec(token);
    if (!match) {
      return null;
    }
    total += Number(match[1]) * suffixToMs(match[2]);
  }
  return asStorableDuration(total);
}

/** Whether a raw number is storable as a duration: finite and not negative. */
export function isValidCustomFieldDurationMs(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0;
}

/** Resolves a suffix the token regex already constrained to the unit table. */
function suffixToMs(suffix: string): number {
  return DURATION_UNITS.find((unit) => unit.suffix === suffix)?.ms ?? 1;
}

/**
 * Rounds a computed span and returns it only if it is actually storable.
 *
 * Both parse paths can overflow to `Infinity` without ever failing their
 * regex: `BARE_NUMBER_REGEX` and `DURATION_TOKEN_REGEX` bound the SHAPE of the
 * digits, not their magnitude, so ~309 digits reach `Number()` as `Infinity`,
 * and a suffix multiplies a smaller one there too. `Infinity` is not `null`, so
 * without this guard it would satisfy the caller's "did it parse?" check and be
 * written to a column that is supposed to hold a finite, non-negative span.
 */
function asStorableDuration(ms: number): number | null {
  const rounded = Math.round(ms);
  return isValidCustomFieldDurationMs(rounded) ? rounded : null;
}
