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
const RGB_COLOR_PATTERN = /^rgba?\((?<body>.*)\)$/i;
const WHITESPACE_PATTERN = /\s+/;

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
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
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

function parseCssNumberOrPercent(value: string): number {
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
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

const themeTokens = {
  [A11yTheme.Light]: {
    "--background": "oklch(0.989 0 0)",
    "--foreground": "oklch(0.232 0 0)",
    "--muted": "oklch(0.7 0 0 / 0.12)",
    "--muted-foreground": "oklch(0.466 0 0)",
    "--border": "oklch(0.5 0.008 267 / 0.1)",
  },
  [A11yTheme.Dark]: {
    "--background": "oklch(0.24 0.005 270)",
    "--foreground": "oklch(0.948 0.002 270)",
    "--muted": "oklch(1 0.003 270 / 0.04)",
    "--muted-foreground": "oklch(0.759 0 0)",
    "--border": "oklch(1 0.005 270 / 0.06)",
  },
} as const;

function themeTokenColor(
  theme: A11yTheme,
  token: keyof (typeof themeTokens)[A11yTheme]
) {
  return themeTokens[theme][token];
}
