/**
 * The token pairs the product actually paints, and what each one owes WCAG 2.2
 * (ISS-5541 part 1).
 *
 * The sibling `agents-status-colour-contrast.test.ts` measures the two Agents
 * status dots. This is the rest of the sweep the ticket asked for: SC 1.4.3
 * (text) as well as SC 1.4.11 (non-text), across the shared vocabulary those
 * screens are built from.
 *
 * `.node` for the same reason as `theme-tokens.node.ts`: it reads the
 * stylesheet through that module, so it must never reach a browser type graph.
 *
 * WHERE THE COLOURS COME FROM. Every badge and alert colour is READ OUT OF
 * `badgeVariants` / `alertVariants` at module load, never transcribed beside
 * them. A hand-copied `bg-success/12` is the failure mode this table exists to
 * prevent: retune the variant and the copy keeps measuring the old pixels, so
 * the lane stays green while the shipped pill regresses. Deriving means the
 * numbers below follow the component. Token references (`var(--card)`) are not
 * copies — `theme-tokens.node.ts` resolves them from `globals.css` itself.
 *
 * STILL AUTHORED HERE, and therefore still able to drift: the `ob-pulse` trough
 * (45%) and the base-layer `outline-ring`, which are CSS-file values with no
 * exported symbol to read. ISS-7879 tracks binding those to their stylesheets.
 *
 * WHAT A PAIR CLAIMS. Every entry names the file that puts those two tokens
 * together. The arithmetic is `contrast.ts`'s; the judgment here is only that
 * these two colours meet on a real surface. A pair nobody renders would produce
 * a number that means nothing, so the pairs for the design-system `StatusDot`'s
 * `tone` prop are deliberately absent: outside Storybook nothing renders it.
 *
 * NOT COVERED, deliberately: the 10-hue chart palette (a categorical palette
 * needs a per-series adjacency matrix, not a background pair) and decorative
 * `--border` separators (exempt from SC 1.4.11).
 */
import { alertVariants } from "@repo/design-system/components/ui/alert";
import type { BadgeProps } from "@repo/design-system/components/ui/badge";
import { badgeVariants } from "@repo/design-system/components/ui/badge";
import { buttonVariants } from "@repo/design-system/components/ui/button";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { INLINE_EDIT_FEEDBACK_CLASS } from "@repo/design-system/components/ui/inline-edit-feedback";
import { INVALID_STATE_UTILITIES } from "@repo/design-system/components/ui/invalid-state";
import { cn } from "@repo/design-system/lib/utils";
import { FOCUS_WITHIN_RING_CLASS } from "../../shared/lib/focus-within-ring";
import {
  A11yTheme,
  ContrastThreshold,
  contrastRatio,
  parseCssColor,
  resolveCompositedBackground,
} from "./contrast";
import {
  ColorProperty,
  requiredUtilityColor,
  UtilityPrefix,
  utilityColor,
} from "./tailwind-color-utility.node";
import { resolveThemeColor } from "./theme-tokens.node";

export const WcagCriterion = {
  /** SC 1.4.3 Contrast (Minimum). */
  TextMinimum: "1.4.3",
  /** SC 1.4.11 Non-text Contrast. */
  NonText: "1.4.11",
} as const;
export type WcagCriterion = (typeof WcagCriterion)[keyof typeof WcagCriterion];

/**
 * Whether a failure is a conformance failure or a recorded observation.
 *
 * `Informational` is for a graphic that is redundant with adjacent text: the dot
 * inside a `ToneBadge` is `aria-hidden` and sits beside a word saying the same
 * thing, so SC 1.4.11's "required to understand the content" test does not
 * clearly bite. It is measured and pinned either way; the split only changes how
 * a failure is escalated. Note the axis is VISIBLE-TEXT adjacency, not the
 * presence of an `aria-label` — a label does nothing for a low-vision sighted
 * user, which is why the standalone Agents dots stay `Required`.
 */
export const Enforcement = {
  Required: "required",
  Informational: "informational",
} as const;
export type Enforcement = (typeof Enforcement)[keyof typeof Enforcement];

export type ContrastPair = {
  id: string;
  criterion: WcagCriterion;
  enforcement: Enforcement;
  /** Painted farthest-first; index 0 must be an opaque surface. */
  surface: readonly string[];
  /** Overrides `surface` for a theme whose utility differs (`dark:bg-…/60`). */
  surfaceByTheme?: Partial<Record<A11yTheme, readonly string[]>>;
  foreground: string;
  /** Overrides `foreground` for a theme whose utility differs (`dark:focus-visible:ring-…`). */
  foregroundByTheme?: Partial<Record<A11yTheme, string>>;
  /** The file that puts these two together. */
  source: string;
};

export type Measurement = {
  id: string;
  criterion: WcagCriterion;
  enforcement: Enforcement;
  ratio: number;
  minimumRatio: number;
  passes: boolean;
};

const CRITERION_MINIMUM_RATIO: Record<WcagCriterion, number> = {
  // Normal text. No pair here is large text: the biggest is the 12px `text-xs`
  // badge label, so the 3:1 large-text allowance never applies.
  [WcagCriterion.TextMinimum]: ContrastThreshold.NormalText,
  [WcagCriterion.NonText]: ContrastThreshold.NonText,
};

export function measurePair(pair: ContrastPair, theme: A11yTheme): Measurement {
  const layers = (pair.surfaceByTheme?.[theme] ?? pair.surface).map((layer) =>
    resolveThemeColor(theme, layer)
  );
  const background = parseCssColor(
    resolveCompositedBackground([...layers].reverse())
  );
  const foreground = parseCssColor(
    resolveThemeColor(theme, pair.foregroundByTheme?.[theme] ?? pair.foreground)
  );
  const ratio = contrastRatio(foreground, background);
  const minimumRatio = CRITERION_MINIMUM_RATIO[pair.criterion];
  return {
    id: pair.id,
    criterion: pair.criterion,
    enforcement: pair.enforcement,
    ratio,
    minimumRatio,
    passes: ratio >= minimumRatio,
  };
}

export function measureTheme(
  theme: A11yTheme,
  pairs: readonly ContrastPair[]
): readonly Measurement[] {
  return pairs.map((pair) => measurePair(pair, theme));
}

const BADGE = "design-system/components/ui/badge.tsx → badgeVariants";
const ALERT = "design-system/components/ui/alert.tsx → alertVariants";
const DOT =
  "design-system/components/ui/primitives/status-badge.tsx → ToneBadge";
const AGENTS_DOT = "app/agents/lib/component-meta.tsx → STATUS_DOT_TONE";
const BUTTON = "design-system/components/ui/button.tsx → buttonVariants";
const CHIP_RING =
  "design-system/components/ui/chip.tsx → CHIP_FOCUS_RING_CLASS";
const FOCUS_WITHIN_RING = "app/shared/lib/focus-within-ring.ts";
const INVALID_STATE = "design-system/components/ui/invalid-state.ts";
const INLINE_EDIT_FEEDBACK =
  "design-system/components/ui/inline-edit-feedback.tsx → INLINE_EDIT_FEEDBACK_CLASS";
const GLOBALS = "design-system/styles/globals.css";
const COMMENTS = "collaboration/client/comments.css";

const CARD: readonly string[] = ["var(--card)"];
const BACKGROUND: readonly string[] = ["var(--background)"];
const POPOVER: readonly string[] = ["var(--popover)"];

/**
 * Every surface a focusable DS primitive is rendered on (ISS-9063 review).
 *
 * `--popover` is here because a Button inside a popover — the Clear button in
 * `table-group-menu-v2` — is not a hypothetical, and dark `globals.css` names
 * popover its own tightest surface. Measuring only background and card let a
 * popover-only token regression through a guard that reported green.
 */
const FOCUS_RING_SURFACES = [
  { on: "background", page: BACKGROUND },
  { on: "card", page: CARD },
  { on: "popover", page: POPOVER },
] as const;

/** `bg-<token>/<pct>` — what Tailwind's opacity modifier compiles to. */
function tint(token: string, percent: number): string {
  return `color-mix(in oklab, var(${token}) ${percent}%, transparent)`;
}

function text(
  id: string,
  foreground: string,
  surface: readonly string[],
  source: string
): ContrastPair {
  return {
    id,
    criterion: WcagCriterion.TextMinimum,
    enforcement: Enforcement.Required,
    surface,
    foreground,
    source,
  };
}

function graphic(
  id: string,
  foreground: string,
  surface: readonly string[],
  source: string,
  enforcement: Enforcement = Enforcement.Required
): ContrastPair {
  return {
    id,
    criterion: WcagCriterion.NonText,
    enforcement,
    surface,
    foreground,
    source,
  };
}

/**
 * A pill's dot takes no `tone` (`ToneBadge` renders `<StatusDot aria-hidden />`),
 * so it paints `bg-current` — the badge variant's TEXT colour, which is not
 * always the tone's own token: `warning` reads `text-warning-foreground`.
 */
function dotInPill(id: string, variant: BadgeVariant): ContrastPair {
  return graphic(
    id,
    badgeText(variant),
    badgePill(variant),
    DOT,
    Enforcement.Informational
  );
}

function badgeTextPair(variant: BadgeVariant): ContrastPair {
  return text(
    `badge ${variant} text`,
    badgeText(variant),
    badgePill(variant),
    BADGE
  );
}

/** Title and description share the variant's fill but not its text colour. */
function alertPairs(variant: AlertVariant): readonly ContrastPair[] {
  const surface = alertSurface(variant);
  return [
    text(`alert ${variant} title`, alertTitleText(variant), surface, ALERT),
    text(
      `alert ${variant} description`,
      alertDescriptionText(variant),
      surface,
      ALERT
    ),
  ];
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;
type ButtonVariant = NonNullable<
  NonNullable<Parameters<typeof buttonVariants>[0]>["variant"]
>;

/** Exhaustive, so a new `Button` variant fails `tsc` here until it is measured. */
const BUTTON_VARIANT_COVERAGE: Record<ButtonVariant, true> = {
  default: true,
  destructive: true,
  outline: true,
  secondary: true,
  ghost: true,
  link: true,
  linkForeground: true,
};

/** Exhaustive, so a new `Badge` variant fails `tsc` here until it is measured. */
const BADGE_VARIANT_COVERAGE: Record<BadgeVariant, true> = {
  default: true,
  secondary: true,
  destructive: true,
  error: true,
  success: true,
  warning: true,
  info: true,
  accent: true,
  ai: true,
  muted: true,
  neutral: true,
  outline: true,
};
type AlertVariant = NonNullable<
  NonNullable<Parameters<typeof alertVariants>[0]>["variant"]
>;

/**
 * The pill a badge variant paints, over the card it sits on.
 *
 * Read out of `badgeVariants` rather than copied beside it: retuning
 * `bg-success/12` moves this surface with it, so the measurement follows the
 * shipped component instead of a stale transcription of it. A variant with no
 * fill (`outline`) is the bare card, which is what it renders as.
 */
function badgePill(variant: BadgeVariant): readonly string[] {
  const fill = utilityColor(
    badgeVariants({ variant }),
    ColorProperty.Background
  );
  return fill === undefined ? CARD : ["var(--card)", fill];
}

/** The badge variant's own text colour — `text-warning-foreground`, not `--warning`. */
function badgeText(variant: BadgeVariant): string {
  return requiredUtilityColor(badgeVariants({ variant }), ColorProperty.Text);
}

function alertSurface(variant: AlertVariant): readonly string[] {
  const fill = utilityColor(
    alertVariants({ variant }),
    ColorProperty.Background
  );
  return fill === undefined ? CARD : ["var(--card)", fill];
}

function alertTitleText(variant: AlertVariant): string {
  return requiredUtilityColor(alertVariants({ variant }), ColorProperty.Text);
}

/** `*:data-[slot=alert-description]:text-…/90` — the dimmer description tone. */
function alertDescriptionText(variant: AlertVariant): string {
  return requiredUtilityColor(
    alertVariants({ variant }),
    ColorProperty.Text,
    UtilityPrefix.AlertDescription
  );
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  text("foreground on background", "var(--foreground)", BACKGROUND, GLOBALS),
  text("card-foreground on card", "var(--card-foreground)", CARD, GLOBALS),
  text(
    "popover-foreground on popover",
    "var(--popover-foreground)",
    ["var(--popover)"],
    GLOBALS
  ),
  text(
    "muted-foreground on background",
    "var(--muted-foreground)",
    BACKGROUND,
    GLOBALS
  ),
  text("muted-foreground on card", "var(--muted-foreground)", CARD, GLOBALS),
  text("link on background", "var(--link)", BACKGROUND, GLOBALS),
  text(
    "inline edit feedback on background",
    requiredUtilityColor(INLINE_EDIT_FEEDBACK_CLASS, ColorProperty.Text),
    BACKGROUND,
    INLINE_EDIT_FEEDBACK
  ),
  text("link on card", "var(--link)", CARD, GLOBALS),
  text(
    "comment highlight text",
    "var(--foreground)",
    ["var(--background)", "var(--highlight)"],
    COMMENTS
  ),
  text(
    "chart axis label on background",
    "var(--chart-axis-label)",
    BACKGROUND,
    GLOBALS
  ),
  text(
    "sidebar-foreground on sidebar",
    "var(--sidebar-foreground)",
    ["var(--sidebar)"],
    GLOBALS
  ),
  text(
    "sidebar-accent-foreground on sidebar-accent",
    "var(--sidebar-accent-foreground)",
    ["var(--sidebar)", "var(--sidebar-accent)"],
    GLOBALS
  ),
  text(
    "sidebar-primary-foreground on sidebar-primary",
    "var(--sidebar-primary-foreground)",
    ["var(--sidebar)", "var(--sidebar-primary)"],
    GLOBALS
  ),
  text(
    "progress badge text",
    "var(--progress-badge-text)",
    ["var(--card)", "var(--progress-badge-bg)"],
    GLOBALS
  ),
  badgeTextPair("default"),
  badgeTextPair("secondary"),
  {
    // `text-white` on a solid fill, and the fill differs by theme, so the
    // `dark:bg-destructive/60` override is read from the same class string
    // rather than transcribed.
    ...badgeTextPair("destructive"),
    surfaceByTheme: {
      [A11yTheme.Dark]: [
        "var(--card)",
        requiredUtilityColor(
          badgeVariants({ variant: "destructive" }),
          ColorProperty.Background,
          UtilityPrefix.Dark
        ),
      ],
    },
  },
  badgeTextPair("error"),
  badgeTextPair("success"),
  badgeTextPair("warning"),
  badgeTextPair("info"),
  badgeTextPair("accent"),
  badgeTextPair("ai"),
  badgeTextPair("muted"),
  badgeTextPair("neutral"),
  // The `outline` variant has no fill; it is the Type badge for a Config
  // component and `kindMeta()`'s fallback on the Agents table.
  badgeTextPair("outline"),
  // The `destructive` variant is NOT the `error` variant: it keeps `bg-card`
  // and tints nothing, so the same text token sits on a plainer surface.
  ...alertPairs("destructive"),
  ...alertPairs("error"),
  ...alertPairs("warning"),
  ...alertPairs("info"),
  ...alertPairs("success"),
  dotInPill("success dot in pill", "success"),
  dotInPill("danger dot in pill", "error"),
  dotInPill("warning dot in pill", "warning"),
  dotInPill("info dot in pill", "info"),
  dotInPill("accent dot in pill", "accent"),
  dotInPill("muted dot in pill", "muted"),
  dotInPill("default dot in neutral pill", "neutral"),
  graphic(
    "agents active dot on background",
    "var(--primary)",
    BACKGROUND,
    AGENTS_DOT
  ),
  graphic(
    "agents new dot on background",
    "var(--success)",
    BACKGROUND,
    AGENTS_DOT
  ),
  // `component-meta.tsx` applies `ob-pulse 1.1s ease-in-out infinite` inline,
  // and that keyframe drops the dot to `opacity: 0.45` at 50%. Measuring only
  // the peak would report a mark as passing that is under the floor half of
  // every cycle, so the trough is its own pair.
  graphic(
    "agents active dot at pulse trough on background",
    tint("--primary", 45),
    BACKGROUND,
    AGENTS_DOT
  ),
  graphic(
    "agents active dot at pulse trough on card",
    tint("--primary", 45),
    CARD,
    AGENTS_DOT
  ),
  graphic(
    "agents new dot at pulse trough on background",
    tint("--success", 45),
    BACKGROUND,
    AGENTS_DOT
  ),
  graphic(
    "agents new dot at pulse trough on card",
    tint("--success", 45),
    CARD,
    AGENTS_DOT
  ),
  graphic(
    "input border on background",
    "var(--input-border)",
    BACKGROUND,
    GLOBALS
  ),
  graphic("input border on card", "var(--input-border)", CARD, GLOBALS),
  graphic(
    "focus ring as authored on background",
    "var(--ring)",
    BACKGROUND,
    DOT
  ),
  graphic("focus ring as authored on card", "var(--ring)", CARD, DOT),
  // `globals.css` applies `outline-ring` to `*` in `@layer base`, so this is
  // the focus indicator most of the product actually shows.
  graphic(
    "default outline-ring on background",
    "var(--ring)",
    BACKGROUND,
    GLOBALS
  ),
  graphic("default outline-ring on card", "var(--ring)", CARD, GLOBALS),
  ...(Object.keys(BUTTON_VARIANT_COVERAGE) as ButtonVariant[]).flatMap(
    (variant) =>
      focusRingPairs(
        `button ${variant}`,
        cn(buttonVariants({ variant })),
        BUTTON
      )
  ),
  ...(Object.keys(BADGE_VARIANT_COVERAGE) as BadgeVariant[]).flatMap(
    (variant) =>
      focusRingPairs(`badge ${variant}`, cn(badgeVariants({ variant })), BADGE)
  ),
  ...invalidFocusRingPairs(),
  // ISS-11058: the recipes the swept `ring-ring/50` sites in `packages/app` and
  // `apps/app` now compose instead of restating that token at 2.16:1.
  ...focusRingPairs("chip recipe", CHIP_FOCUS_RING_CLASS, CHIP_RING),
  ...FOCUS_RING_SURFACES.map(({ on, page }) =>
    graphic(
      `focus-within frame focus ring on ${on}`,
      requiredUtilityColor(
        FOCUS_WITHIN_RING_CLASS,
        ColorProperty.Ring,
        UtilityPrefix.FocusWithin
      ),
      page,
      FOCUS_WITHIN_RING
    )
  ),
];

/**
 * A DS primitive variant's focus ring (ISS-9063), read from the class string
 * the component actually renders — through `cn()`, so a variant's ring override
 * replaces the base ring the way tailwind-merge does at runtime rather than
 * reading as ambiguous.
 *
 * Shared by `Button` and `Badge` rather than written twice: `Badge` is focusable
 * through `asChild` and carried the same below-the-floor ring override this
 * ticket removes from `Button`, so a Button-only sweep stayed green while the
 * sibling stayed broken.
 */
function focusRingPairs(
  id: string,
  className: string,
  source: string
): readonly ContrastPair[] {
  const ring = requiredUtilityColor(
    className,
    ColorProperty.Ring,
    UtilityPrefix.FocusVisible
  );
  const darkRing = utilityColor(
    className,
    ColorProperty.Ring,
    UtilityPrefix.DarkFocusVisible
  );
  const foregroundByTheme =
    darkRing === undefined ? {} : { [A11yTheme.Dark]: darkRing };
  return FOCUS_RING_SURFACES.map(({ on, page }) => ({
    ...graphic(
      `${id} focus ring on ${on}`,
      ring,
      ringSurface(page, className, UtilityPrefix.None),
      source
    ),
    surfaceByTheme: {
      [A11yTheme.Dark]: ringSurface(page, className, UtilityPrefix.Dark),
    },
    foregroundByTheme,
  }));
}

/**
 * What the ring is actually painted against.
 *
 * A ring is a box-shadow OUTSIDE the border box, so the colour it has to stand
 * out from is whatever is painted immediately outside the control — which is
 * not always the page. A variant carrying `ring-offset-<colour>` puts a band of
 * that colour between fill and ring; a variant with an opaque fill and no
 * offset puts the ring straight against its own fill.
 *
 * Measuring every variant against the bare page is what let the destructive
 * Button through: `--ring` is 1.39:1 on light `--destructive`, and the sweep
 * read 5.43:1 for it because it measured a surface that variant never showed
 * the ring against.
 */
function ringSurface(
  page: readonly string[],
  className: string,
  fillPrefix: UtilityPrefix
): readonly string[] {
  const offset = utilityColor(
    className,
    ColorProperty.RingOffset,
    UtilityPrefix.FocusVisible
  );
  if (offset !== undefined) {
    return [...page, offset];
  }
  const fill =
    utilityColor(className, ColorProperty.Background, fillPrefix) ??
    utilityColor(className, ColorProperty.Background);
  return fill === undefined ? page : [...page, fill];
}

/**
 * The focus indicator a form primitive paints while `aria-invalid` (ISS-9063
 * review).
 *
 * This is the state the Button-only sweep could not see. `aria-invalid:ring-…`
 * and `focus-visible:ring-ring` are both one-variant rules, so they tie on
 * specificity and the cascade decided: a focused invalid field painted the 20%
 * red halo, 1.32:1 on light `--background`, and no pair measured it.
 * `invalid-state.ts` now settles it with a compound selector, and this reads
 * the winning colour out of that one exported string — every primitive carrying
 * the invalid state composes it, so there is no per-primitive copy to drift.
 *
 * Against the page rather than a fill: these primitives render on `--background`
 * or `--card`, and `bg-input` is transparent in light.
 */
function invalidFocusRingPairs(): readonly ContrastPair[] {
  const ring = requiredUtilityColor(
    INVALID_STATE_UTILITIES,
    ColorProperty.Ring,
    UtilityPrefix.AriaInvalidFocusVisible
  );
  const darkRing = requiredUtilityColor(
    INVALID_STATE_UTILITIES,
    ColorProperty.Ring,
    UtilityPrefix.DarkAriaInvalidFocusVisible
  );
  const foregroundByTheme = { [A11yTheme.Dark]: darkRing };
  return [
    {
      ...graphic(
        "invalid focus ring on background",
        ring,
        BACKGROUND,
        INVALID_STATE
      ),
      foregroundByTheme,
    },
    {
      ...graphic("invalid focus ring on card", ring, CARD, INVALID_STATE),
      foregroundByTheme,
    },
  ];
}
