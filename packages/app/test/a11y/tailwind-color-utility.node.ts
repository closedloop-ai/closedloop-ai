/**
 * Reads the colour a Tailwind utility actually paints, out of a production
 * `cva` class string (ISS-5541 review follow-up).
 *
 * WHY THIS EXISTS. The contrast sweep used to hand-copy each variant's fill —
 * `bg-success/12` written out again as a 12% mix beside the pair. That is
 * SSOT-drift-by-copy in its most dangerous form: retune `badgeVariants` to
 * `bg-success/20` and the copy keeps measuring the old pixels, so the a11y lane
 * stays green while the shipped badge regresses. Deriving the expression from
 * the class map instead means there is no copy left to drift.
 *
 * `.node` for the same reason as `theme-tokens.node.ts`: it asks that module
 * whether a name is a declared theme token, so it reads the filesystem and must
 * never reach a browser type graph.
 *
 * A utility this cannot read THROWS. Returning a default would hand the caller a
 * plausible-but-wrong colour, and a wrong colour is a contrast number that lies.
 */
import { isThemeToken } from "./theme-tokens.node";

/** The utility family a colour is read from. */
export const ColorProperty = {
  Background: "bg",
  Text: "text",
  /** A `ring-<token>` box-shadow colour, the DS focus indicator (ISS-9063). */
  Ring: "ring",
  /**
   * A `ring-offset-<token>` band. It is painted BETWEEN the control and its
   * ring, so where a variant sets one it — not the control's fill — is the
   * colour the ring has to stand out from.
   */
  RingOffset: "ring-offset",
} as const;
export type ColorProperty = (typeof ColorProperty)[keyof typeof ColorProperty];

/**
 * Tailwind variant prefixes the product's class maps actually author. A token
 * carrying any OTHER prefix is conditional styling this sweep does not measure
 * (`[a&]:hover:`), so it is skipped. The focus prefixes are read only for the
 * focus ring, where the state IS what is under test — including the compound
 * `aria-invalid:focus-visible:`, the indicator a focused invalid field paints.
 * The unfocused `aria-invalid:` halo stays unmeasured: the state indicator
 * there is the full-strength border, not the ring behind it.
 */
export const UtilityPrefix = {
  /** No prefix — the colour painted in the default state. */
  None: "",
  Dark: "dark:",
  AlertDescription: "*:data-[slot=alert-description]:",
  FocusVisible: "focus-visible:",
  /** A field frame ringing the input inside it (ISS-11058). */
  FocusWithin: "focus-within:",
  DarkFocusVisible: "dark:focus-visible:",
  AriaInvalidFocusVisible: "aria-invalid:focus-visible:",
  DarkAriaInvalidFocusVisible: "dark:aria-invalid:focus-visible:",
} as const;
export type UtilityPrefix = (typeof UtilityPrefix)[keyof typeof UtilityPrefix];

/** Bare colour keywords Tailwind ships that are not theme tokens. */
const LITERAL_COLORS: Readonly<Record<string, string>> = {
  white: "#ffffff",
  black: "#000000",
};

const UTILITY_PATTERN = /^(?<name>[a-z0-9-]+?)(?:\/(?<percent>\d{1,3}))?$/i;
const WHITESPACE_PATTERN = /\s+/;

/**
 * The colour `property` paints under `prefix`, as a CSS expression
 * `resolveThemeColor` can resolve — or `undefined` when the class map sets no
 * such colour (the badge `outline` variant has no fill at all).
 *
 * Throws when a prefix matches more than one colour, because silently taking the
 * first would measure whichever utility happened to be authored earliest.
 */
export function utilityColor(
  className: string,
  property: ColorProperty,
  prefix: UtilityPrefix = UtilityPrefix.None
): string | undefined {
  const matches = className
    .split(WHITESPACE_PATTERN)
    .filter((token) => token.length > 0)
    .map((token) => utilityValue(token, property, prefix))
    .filter((value): value is string => value !== undefined);

  const unique = [...new Set(matches)];
  if (unique.length > 1) {
    throw new Error(
      `Ambiguous ${prefix}${property}- colour in class string: ${unique.join(", ")}`
    );
  }
  return unique[0];
}

/**
 * `utilityColor`, but a missing colour is itself the failure. Use it wherever
 * the pair table needs a colour to exist — a variant that quietly stopped
 * setting a fill would otherwise measure the bare surface and could pass.
 */
export function requiredUtilityColor(
  className: string,
  property: ColorProperty,
  prefix: UtilityPrefix = UtilityPrefix.None
): string {
  const color = utilityColor(className, property, prefix);
  if (color === undefined) {
    throw new Error(
      `No ${prefix}${property}- colour in class string: ${className}`
    );
  }
  return color;
}

function utilityValue(
  token: string,
  property: ColorProperty,
  prefix: UtilityPrefix
): string | undefined {
  if (!token.startsWith(prefix)) {
    return undefined;
  }
  const bare = token.slice(prefix.length);
  // A further-prefixed utility (`[a&]:hover:bg-…`) fails this anchored check,
  // which is why a hover or focus fill never reaches the measurement.
  if (!bare.startsWith(`${property}-`)) {
    return undefined;
  }

  const match = bare.slice(property.length + 1).match(UTILITY_PATTERN);
  if (!match?.groups) {
    return undefined;
  }
  return colorExpression(match.groups.name, match.groups.percent);
}

/**
 * A utility whose name is neither a declared token nor a known colour keyword is
 * NOT a colour — `text-xs` and `text-sm` share the `text-` family — so it is
 * skipped rather than resolved into a nonexistent `--xs`.
 */
function colorExpression(
  name: string,
  percent: string | undefined
): string | undefined {
  const base = LITERAL_COLORS[name] ?? tokenReference(name);
  if (base === undefined) {
    return undefined;
  }
  if (percent === undefined) {
    return base;
  }
  return `color-mix(in oklab, ${base} ${Number(percent)}%, transparent)`;
}

function tokenReference(name: string): string | undefined {
  return isThemeToken(`--${name}`) ? `var(--${name})` : undefined;
}
