import { vi } from "vitest";

/** The real formatter, captured before any spy can replace it. */
const REAL_TO_LOCALE_STRING: (
  this: number,
  locales?: Intl.LocalesArgument,
  options?: Intl.NumberFormatOptions
) => string = Number.prototype.toLocaleString;

/** The real constructor, captured before any spy can replace it. */
const RealNumberFormat = Intl.NumberFormat;

/**
 * Resolves an omitted locale to German for the rest of the test, so a suite can
 * tell an explicitly-pinned locale apart from an inherited one. A US runner
 * renders the two identically, which is why ISS-7336's implicit `undefined`
 * survived: without this the regression is invisible and a counterfactual that
 * reverts the pin still passes. Call inside the test; the caller restores with
 * `vi.restoreAllMocks()`.
 */
export function useGermanDefaultLocale(): void {
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions
  ): string {
    return REAL_TO_LOCALE_STRING.call(this, locales ?? "de-DE", options);
  });
  // Both routes, even though today's callers only use `toLocaleString`:
  // moving a formatter to `Intl.NumberFormat` is the natural refactor here, and
  // a half-stubbed harness would keep passing while the regression returned.
  // biome-ignore lint/complexity/useArrowFunction: production calls this with `new`, and an arrow is not constructable.
  vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions
  ): Intl.NumberFormat {
    return new RealNumberFormat(locales ?? "de-DE", options);
  });
}
