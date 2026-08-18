export const A11yTheme = {
  Light: "light",
  Dark: "dark",
} as const;

export type A11yTheme = (typeof A11yTheme)[keyof typeof A11yTheme];

export const ContrastThreshold = {
  NormalText: 4.5,
  LargeText: 3,
  NonText: 3,
} as const;

export type ContrastThreshold =
  (typeof ContrastThreshold)[keyof typeof ContrastThreshold];

export type RgbColor = {
  r: number;
  g: number;
  b: number;
  alpha: number;
};

const HEX_COLOR_PATTERN =
  /^#(?<short>[0-9a-f]{3,4})$|^#(?<long>[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OKLCH_COLOR_PATTERN =
  /^oklch\(\s*(?<l>[\d.]+%?)\s+(?<c>[\d.]+)\s+(?<h>[\d.]+|none)(?:\s*\/\s*(?<alpha>[\d.]+%?))?\s*\)$/i;
// Chromium resolves `color-mix(in oklab, …)` — what Tailwind's opacity modifier
// (`bg-card/95`) compiles to — and serializes the computed value back out as
// `oklab()`, so any element styled that way reaches this parser in OKLab form.
const OKLAB_COLOR_PATTERN =
  /^oklab\(\s*(?<l>none|-?[\d.]+%?)\s+(?<a>none|-?[\d.]+%?)\s+(?<b>none|-?[\d.]+%?)(?:\s*\/\s*(?<alpha>none|[\d.]+%?))?\s*\)$/i;
/**
 * CIE Lab — which is the form the PRODUCTION stylesheet actually delivers every
 * theme token in, so this is not an exotic case.
 *
 * `globals.css` authors the palette in `oklch()`, but Tailwind v4 runs the
 * bundle through Lightning CSS, which downlevels each token to a hex fallback
 * followed by a `lab()` declaration and emits no `oklch()` at all. A dev server
 * and Storybook serve the authored form, so a browser reading a computed token
 * THERE reports `oklch(0.989 0 0)` — while the same read against a `next build`,
 * which is what the Playwright suite runs, reports `lab(98.724 0 0)`. Both have
 * to parse, or a spec is green locally and red in CI (ISS-5365).
 *
 * Note the anchors: `oklab()`/`oklch()` are matched by their own patterns and
 * cannot fall through to this one.
 */
const LAB_COLOR_PATTERN =
  /^lab\(\s*(?<l>none|-?[\d.]+%?)\s+(?<a>none|-?[\d.]+%?)\s+(?<b>none|-?[\d.]+%?)(?:\s*\/\s*(?<alpha>none|-?[\d.]+%?))?\s*\)$/i;
const RGB_COLOR_PATTERN = /^rgba?\((?<body>.*)\)$/i;
const WHITESPACE_PATTERN = /\s+/;
/** CSS maps an OKLab `a`/`b` percentage of 100% onto 0.4. */
const OKLAB_AXIS_PERCENT_REFERENCE = 0.4;
/** CSS maps a CIE Lab lightness percentage of 100% onto 100. */
const LAB_LIGHTNESS_PERCENT_REFERENCE = 100;
/** CSS maps a CIE Lab `a`/`b` percentage of 100% onto 125. */
const LAB_AXIS_PERCENT_REFERENCE = 125;
/** The CIE standard's `κ` and `ε`, exact rather than rounded. */
const LAB_KAPPA = 24_389 / 27;
const LAB_EPSILON = 216 / 24_389;
/** CSS resolves `lab()` against D50, not the D65 that sRGB is defined on. */
const LAB_WHITE_POINT_X = 0.964_295_676_4;
const LAB_WHITE_POINT_Z = 0.825_104_602_5;

export function assertContrastPair({
  background,
  foreground,
  label,
  threshold = ContrastThreshold.NormalText,
}: {
  background: string;
  foreground: string;
  label: string;
  threshold?: ContrastThreshold;
}) {
  const ratio = contrastRatio(
    parseCssColor(foreground),
    parseCssColor(background)
  );

  if (ratio < threshold) {
    throw new Error(
      `${label} contrast ${ratio.toFixed(2)} is below WCAG threshold ${threshold}`
    );
  }
}

export function expectElementContrast(
  element: Element,
  {
    background,
    label,
    threshold = ContrastThreshold.NormalText,
  }: {
    background?: string;
    label: string;
    threshold?: ContrastThreshold;
  }
) {
  const foreground = getComputedStyle(element).color;
  const resolvedBackground = background ?? findCompositedBackground(element);
  assertContrastPair({
    background: resolvedBackground,
    foreground,
    label,
    threshold,
  });
}

export function applyA11yTheme(root: HTMLElement, theme: A11yTheme) {
  root.classList.toggle("dark", theme === A11yTheme.Dark);
  root.dataset.theme = theme;
  for (const [name, value] of Object.entries(themeTokens[theme])) {
    root.style.setProperty(name, value);
  }
}

export function themeBackground(theme: A11yTheme) {
  return themeTokenColor(theme, "--background");
}

export function themeForeground(theme: A11yTheme) {
  return themeTokenColor(theme, "--foreground");
}

/**
 * Flatten a translucent colour onto the surface behind it (ISS-5362).
 *
 * `contrastRatio` composites its own foreground, but a translucent BACKGROUND —
 * a donut slice drawn at partial alpha over the card, say — has to be resolved
 * before anything can claim a ratio against it, or the claim is made against a
 * colour nothing on screen is showing.
 */
export function compositeColorOver(
  foreground: RgbColor,
  background: RgbColor
): RgbColor {
  return compositeOver(foreground, background);
}

export function contrastRatio(foreground: RgbColor, background: RgbColor) {
  const blendedForeground = blendAlpha(foreground, background);
  const foregroundLuminance = relativeLuminance(blendedForeground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

export function resolveCompositedBackground(
  backgroundsClosestFirst: string[],
  fallback = "rgb(255, 255, 255)"
) {
  let resolvedBackground = parseCssColor(fallback);

  for (const background of [...backgroundsClosestFirst].reverse()) {
    const layer = parseCssColor(background);
    if (layer.alpha <= 0) {
      continue;
    }
    resolvedBackground = compositeOver(layer, resolvedBackground);
  }

  return serializeRgbColor(resolvedBackground);
}

export function parseCssColor(value: string): RgbColor {
  const trimmed = value.trim();
  if (trimmed === "transparent") {
    return { alpha: 0, b: 0, g: 0, r: 0 };
  }

  const hexMatch = trimmed.match(HEX_COLOR_PATTERN);
  if (hexMatch?.groups?.short) {
    return parseHexColor(
      hexMatch.groups.short
        .split("")
        .map((char) => `${char}${char}`)
        .join("")
    );
  }
  if (hexMatch?.groups?.long) {
    return parseHexColor(hexMatch.groups.long);
  }

  const rgbMatch = trimmed.match(RGB_COLOR_PATTERN);
  if (rgbMatch?.groups) {
    return parseRgbFunction(rgbMatch.groups.body);
  }

  const oklchMatch = trimmed.match(OKLCH_COLOR_PATTERN);
  if (oklchMatch?.groups) {
    return oklchToRgb({
      alpha: clampAlpha(
        parseCssNumberOrPercent(oklchMatch.groups.alpha ?? "1")
      ),
      chroma: Number(oklchMatch.groups.c),
      hue: oklchMatch.groups.h === "none" ? 0 : Number(oklchMatch.groups.h),
      lightness: parseCssNumberOrPercent(oklchMatch.groups.l),
    });
  }

  const oklabMatch = trimmed.match(OKLAB_COLOR_PATTERN);
  if (oklabMatch?.groups) {
    return oklabToRgb({
      a: parseLabComponent(oklabMatch.groups.a, OKLAB_AXIS_PERCENT_REFERENCE),
      alpha: clampAlpha(parseLabComponent(oklabMatch.groups.alpha ?? "1", 1)),
      b: parseLabComponent(oklabMatch.groups.b, OKLAB_AXIS_PERCENT_REFERENCE),
      lightness: parseLabComponent(oklabMatch.groups.l, 1),
    });
  }

  const labMatch = trimmed.match(LAB_COLOR_PATTERN);
  if (labMatch?.groups) {
    return labToRgb({
      a: parseLabComponent(labMatch.groups.a, LAB_AXIS_PERCENT_REFERENCE),
      alpha: clampAlpha(parseLabComponent(labMatch.groups.alpha ?? "1", 1)),
      b: parseLabComponent(labMatch.groups.b, LAB_AXIS_PERCENT_REFERENCE),
      lightness: parseLabComponent(
        labMatch.groups.l,
        LAB_LIGHTNESS_PERCENT_REFERENCE
      ),
    });
  }

  throw new Error(`Unsupported CSS color: ${value}`);
}

function parseRgbFunction(body: string): RgbColor {
  const [channelsRaw, slashAlphaRaw] = body
    .split("/")
    .map((part) => part.trim());
  const parts = channelsRaw.includes(",")
    ? channelsRaw.split(",").map((part) => part.trim())
    : channelsRaw.split(WHITESPACE_PATTERN);
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`Unsupported RGB color: rgb(${body})`);
  }

  return {
    alpha: clampAlpha(
      parseCssNumberOrPercent(slashAlphaRaw ?? parts[3] ?? "1")
    ),
    b: parseRgbChannel(parts[2] ?? ""),
    g: parseRgbChannel(parts[1] ?? ""),
    r: parseRgbChannel(parts[0] ?? ""),
  };
}

function parseHexColor(hex: string): RgbColor {
  const hasAlpha = hex.length === 8;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    alpha: hasAlpha ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function oklchToRgb({
  alpha,
  chroma,
  hue,
  lightness,
}: {
  alpha: number;
  chroma: number;
  hue: number;
  lightness: number;
}): RgbColor {
  if (
    !(
      Number.isFinite(chroma) &&
      Number.isFinite(hue) &&
      Number.isFinite(lightness)
    )
  ) {
    throw new Error("OKLCH channels must be finite numbers");
  }

  const hueRadians = (hue * Math.PI) / 180;

  return oklabToRgb({
    a: chroma * Math.cos(hueRadians),
    alpha,
    b: chroma * Math.sin(hueRadians),
    lightness,
  });
}

function oklabToRgb({
  a,
  alpha,
  b,
  lightness,
}: {
  a: number;
  alpha: number;
  b: number;
  lightness: number;
}): RgbColor {
  if (
    !(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(lightness))
  ) {
    throw new Error("OKLab channels must be finite numbers");
  }

  const lPrime = lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
  const mPrime = lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
  const sPrime = lightness - 0.089_484_177_5 * a - 1.291_485_548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  return {
    alpha,
    b: linearSrgbToByte(
      -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s
    ),
    g: linearSrgbToByte(
      -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s
    ),
    r: linearSrgbToByte(
      4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s
    ),
  };
}

/**
 * CIE Lab (D50, which is the white point CSS defines `lab()` on) → sRGB.
 *
 * Lab → XYZ is the CIE inverse transfer function; XYZ → linear sRGB is the one
 * matrix that folds the Bradford D50→D65 adaptation into the D65 XYZ →
 * linear-sRGB matrix, i.e. the standard ICC sRGB-D50 matrix.
 *
 * Checked against the hex fallbacks Lightning CSS emits for its OWN `lab()`
 * output, which makes the build itself the oracle: `lab(98.724% 0 0)` → `#fbfbfb`
 * and `lab(13.5333% .104085 -3.00337)` → `#212327`, both exact.
 */
function labToRgb({
  a,
  alpha,
  b,
  lightness,
}: {
  a: number;
  alpha: number;
  b: number;
  lightness: number;
}): RgbColor {
  if (
    !(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(lightness))
  ) {
    throw new Error("CIE Lab channels must be finite numbers");
  }

  const fy = (lightness + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x =
    (fx ** 3 > LAB_EPSILON ? fx ** 3 : (116 * fx - 16) / LAB_KAPPA) *
    LAB_WHITE_POINT_X;
  const y =
    lightness > LAB_KAPPA * LAB_EPSILON ? fy ** 3 : lightness / LAB_KAPPA;
  const z =
    (fz ** 3 > LAB_EPSILON ? fz ** 3 : (116 * fz - 16) / LAB_KAPPA) *
    LAB_WHITE_POINT_Z;

  return {
    alpha,
    b: linearSrgbToByte(
      0.071_955_379_9 * x - 0.228_976_826_4 * y + 1.405_386_058_3 * z
    ),
    g: linearSrgbToByte(
      -0.978_795_502_9 * x + 1.916_254_567_3 * y + 0.033_442_731_2 * z
    ),
    r: linearSrgbToByte(
      3.134_135_957 * x - 1.617_386_332_2 * y - 0.490_661_946 * z
    ),
  };
}

function parseCssNumberOrPercent(value: string): number {
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
}

/**
 * Resolves one Lab-family component, for both `oklab()` and CIE `lab()`. Each
 * axis has its own percentage reference — OKLab `a`/`b` at 100% = 0.4, CIE Lab
 * `a`/`b` at 100% = 125, CIE lightness at 100% = 100, OKLab lightness and both
 * alphas at 100% = 1 — so the caller supplies it. A missing component (`none`)
 * resolves to 0, which is CSS's own rule and keeps a `… / none` layer from being
 * composited as opaque.
 */
function parseLabComponent(value: string, percentReference: number): number {
  if (value.toLowerCase() === "none") {
    return 0;
  }
  return (
    parseCssNumberOrPercent(value) *
    (value.endsWith("%") ? percentReference : 1)
  );
}

function parseRgbChannel(value: string): number {
  return clampRgb(
    value.endsWith("%") ? Number(value.slice(0, -1)) * 2.55 : Number(value)
  );
}

function linearSrgbToByte(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded =
    clamped <= 0.003_130_8
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return encoded * 255;
}

function findCompositedBackground(element: Element): string {
  const backgrounds: string[] = [];
  let current: Element | null = element;
  while (current) {
    const backgroundColor = getComputedStyle(current).backgroundColor;
    if (backgroundColor) {
      backgrounds.push(backgroundColor);
    }
    current = current.parentElement;
  }
  return resolveCompositedBackground(backgrounds);
}

function blendAlpha(foreground: RgbColor, background: RgbColor): RgbColor {
  if (foreground.alpha >= 1) {
    return foreground;
  }
  return compositeOver(foreground, background);
}

function compositeOver(foreground: RgbColor, background: RgbColor): RgbColor {
  const alpha = foreground.alpha;
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    alpha: 1,
  };
}

function serializeRgbColor({ alpha, b, g, r }: RgbColor): string {
  if (alpha >= 1) {
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

function relativeLuminance({ r, g, b }: RgbColor): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    if (normalized <= 0.039_28) {
      return normalized / 12.92;
    }
    return ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function clampRgb(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("RGB channels must be finite numbers");
  }
  return Math.min(255, Math.max(0, value));
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Alpha channel must be a finite number");
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * The dichromacies WCAG colour choices most often fall down on (ISS-5362).
 *
 * Both collapse the red-green axis, and they collapse it DIFFERENTLY — a pair
 * that survives one can vanish under the other — so a palette claim is only
 * worth making when it has been checked against both.
 */
export const ColorVisionDeficiency = {
  Protanopia: "protanopia",
  Deuteranopia: "deuteranopia",
} as const;

export type ColorVisionDeficiency =
  (typeof ColorVisionDeficiency)[keyof typeof ColorVisionDeficiency];

/**
 * Re-render a colour as a dichromat sees it, so a contrast claim can be made
 * about the vision the claim is FOR rather than about typical vision.
 *
 * Brettel/Viénot (1999): convert to the LMS cone space, zero out the missing
 * cone by re-deriving its response from the two that remain, convert back. The
 * matrices are the published Viénot–Brettel–Mollon values.
 *
 * Alpha is carried through untouched — a deficiency changes which wavelengths
 * are resolved, not how much light gets through — so the result still composites
 * over its background exactly as the input would have.
 */
export function simulateColorVisionDeficiency(
  color: RgbColor,
  deficiency: ColorVisionDeficiency
): RgbColor {
  const linear = [color.r, color.g, color.b].map(byteToLinearSrgb);
  const cones = applyMatrix(SRGB_TO_LMS, linear);
  const collapsed = applyMatrix(CONE_COLLAPSE[deficiency], cones);
  const [r, g, b] = applyMatrix(LMS_TO_SRGB, collapsed).map(linearSrgbToByte);

  return { alpha: color.alpha, b, g, r };
}

const SRGB_TO_LMS = [
  [17.8824, 43.5161, 4.119_35],
  [3.455_65, 27.1554, 3.867_14],
  [0.029_956_6, 0.184_309, 1.467_09],
];

const LMS_TO_SRGB = [
  [0.080_944_447_9, -0.130_504_409, 0.116_721_066],
  [-0.010_248_533_5, 0.054_019_326_6, -0.113_614_708],
  [-0.000_365_296_938, -0.004_121_614_69, 0.693_511_405],
];

/**
 * Re-derives the absent cone's response from the two surviving ones. Protanopia
 * loses L, deuteranopia loses M, so each matrix rewrites exactly that row and
 * leaves the others as identity.
 */
const CONE_COLLAPSE: Record<ColorVisionDeficiency, number[][]> = {
  [ColorVisionDeficiency.Protanopia]: [
    [0, 2.023_44, -2.525_81],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [ColorVisionDeficiency.Deuteranopia]: [
    [1, 0, 0],
    [0.494_207, 0, 1.248_27],
    [0, 0, 1],
  ],
};

function applyMatrix(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) =>
    row.reduce((sum, cell, index) => sum + cell * vector[index], 0)
  );
}

/** The sRGB transfer function, inverted — the same curve `relativeLuminance` uses. */
function byteToLinearSrgb(channel: number): number {
  const normalized = channel / 255;
  if (normalized <= 0.039_28) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Mirrors `packages/design-system/styles/globals.css` for the tokens tests assert on. */
const themeTokens = {
  [A11yTheme.Light]: {
    "--background": "oklch(0.989 0 0)",
    "--foreground": "oklch(0.232 0 0)",
    "--muted": "oklch(0.7 0 0 / 0.12)",
    "--muted-foreground": "oklch(0.466 0 0)",
    "--border": "oklch(0.5 0.008 267 / 0.1)",
    "--card": "oklch(0.989 0 0)",
    "--destructive": "oklch(0.62 0.22 29.2)",
    "--success": "oklch(0.629 0.144 155.113)",
    "--info": "oklch(0.6 0.15 250)",
    "--chart-4": "oklch(0.902 0.128 87.8)",
  },
  [A11yTheme.Dark]: {
    "--background": "oklch(0.24 0.005 270)",
    "--foreground": "oklch(0.948 0.002 270)",
    "--muted": "oklch(1 0.003 270 / 0.04)",
    "--muted-foreground": "oklch(0.759 0 0)",
    "--border": "oklch(1 0.005 270 / 0.06)",
    "--card": "oklch(0.255 0.008 270)",
    "--destructive": "oklch(0.62 0.22 29.2)",
    "--success": "oklch(0.6626 0.1659 148.11)",
    "--info": "oklch(0.55 0.12 250)",
    "--chart-4": "oklch(0.8 0.17 119)",
  },
} as const;

const VAR_REFERENCE_PATTERN = /^var\(\s*(?<token>--[\w-]+)\s*\)$/;
const COLOR_MIX_PATTERN =
  /^color-mix\(\s*in\s+[\w-]+\s*,\s*(?<color>.+?)\s+(?<percent>[\d.]+)%\s*,\s*transparent\s*\)$/i;

/**
 * Resolve a THEME-authored colour into something `parseCssColor` understands
 * (ISS-5362, #4514 review).
 *
 * The palettes under test are written the way a stylesheet writes them —
 * `var(--destructive)`, or a `color-mix(…, transparent)` that weakens a token
 * without inventing a bespoke value — so a test that wants to make a contrast
 * claim about a SHIPPED palette has to read the shipped strings rather than a
 * restated copy of their resolved values. Only the two forms the product
 * actually uses are handled; anything else falls through to `parseCssColor`,
 * which throws on input it does not recognise rather than guessing.
 */
export function resolveThemeColor(theme: A11yTheme, value: string): RgbColor {
  const trimmed = value.trim();

  const variable = trimmed.match(VAR_REFERENCE_PATTERN)?.groups?.token;
  if (variable) {
    const tokens: Readonly<Record<string, string>> = themeTokens[theme];
    if (!Object.hasOwn(tokens, variable)) {
      throw new Error(
        `Unknown theme token ${variable} — add it from globals.css`
      );
    }
    return resolveThemeColor(theme, tokens[variable]);
  }

  const mix = trimmed.match(COLOR_MIX_PATTERN)?.groups;
  if (mix) {
    // Mixing toward `transparent` is alpha, not a hue shift: the result is the
    // same colour at `percent` opacity, which is what the ring composites over
    // the card.
    const base = resolveThemeColor(theme, mix.color);
    return { ...base, alpha: base.alpha * (Number(mix.percent) / 100) };
  }

  return parseCssColor(trimmed);
}

function themeTokenColor(
  theme: A11yTheme,
  token: keyof (typeof themeTokens)[A11yTheme]
) {
  return themeTokens[theme][token];
}
