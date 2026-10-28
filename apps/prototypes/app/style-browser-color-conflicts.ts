import {
  TokenCategory,
  type TokenDefinition,
  type TokenEdits,
} from "./style-browser-editor-data";

export type ColorConflict = {
  token: TokenDefinition;
  nearestToken: TokenDefinition;
  distance: number;
};

export function buildColorConflictMap({
  edits,
  tokens,
}: {
  edits: TokenEdits;
  tokens: readonly TokenDefinition[];
}): ReadonlyMap<string, ColorConflict> {
  const colorPoints = tokens.flatMap((token) => {
    if (token.category !== TokenCategory.Color) {
      return [];
    }
    const color = parseColorPoint(edits[token.id] ?? token.initialValue);
    if (!(color && color.chroma >= MIN_CONFLICT_CHROMA)) {
      return [];
    }
    return [{ color, token }];
  });
  const conflicts = new Map<string, ColorConflict>();

  for (const point of colorPoints) {
    let nearest: ColorConflict | null = null;
    for (const candidate of colorPoints) {
      if (candidate.token.id === point.token.id) {
        continue;
      }
      const distance = oklabDistance(point.color, candidate.color);
      if (distance <= EXACT_MATCH_DISTANCE) {
        continue;
      }
      if (distance > COLOR_CONFLICT_DISTANCE) {
        continue;
      }
      if (!nearest || distance < nearest.distance) {
        nearest = {
          distance,
          nearestToken: candidate.token,
          token: point.token,
        };
      }
    }
    if (nearest) {
      conflicts.set(point.token.id, nearest);
    }
  }

  return conflicts;
}

function parseColorPoint(value: string): OklabPoint | null {
  const trimmed = value.trim();
  const oklchMatch = trimmed.match(oklchPattern);
  if (oklchMatch?.groups) {
    return oklchToPoint({
      chroma: Number(oklchMatch.groups.chroma),
      hue: oklchMatch.groups.hue === "none" ? 0 : Number(oklchMatch.groups.hue),
      lightness: parseNumberOrPercent(oklchMatch.groups.lightness),
    });
  }
  const rgbMatch = trimmed.match(rgbPattern);
  if (rgbMatch?.groups) {
    return rgbToOklabPoint({
      blue: Number(rgbMatch.groups.blue),
      green: Number(rgbMatch.groups.green),
      red: Number(rgbMatch.groups.red),
    });
  }
  const hexMatch = trimmed.match(hexPattern);
  if (hexMatch?.groups) {
    const hexValue = hexMatch.groups.hex;
    const red = Number.parseInt(hexValue.slice(0, 2), 16);
    const green = Number.parseInt(hexValue.slice(2, 4), 16);
    const blue = Number.parseInt(hexValue.slice(4, 6), 16);
    return rgbToOklabPoint({ blue, green, red });
  }
  return null;
}

function oklchToPoint({
  lightness,
  chroma,
  hue,
}: {
  lightness: number;
  chroma: number;
  hue: number;
}): OklabPoint {
  const hueRadians = (hue * Math.PI) / 180;
  return {
    a: chroma * Math.cos(hueRadians),
    b: chroma * Math.sin(hueRadians),
    chroma,
    lightness,
  };
}

function rgbToOklabPoint({
  red,
  green,
  blue,
}: {
  red: number;
  green: number;
  blue: number;
}): OklabPoint {
  const linearRed = srgbToLinear(red / 255);
  const linearGreen = srgbToLinear(green / 255);
  const linearBlue = srgbToLinear(blue / 255);
  const l = Math.cbrt(
    0.412_221_470_8 * linearRed +
      0.536_332_536_3 * linearGreen +
      0.051_445_992_9 * linearBlue
  );
  const m = Math.cbrt(
    0.211_903_498_2 * linearRed +
      0.680_699_545_1 * linearGreen +
      0.107_396_956_6 * linearBlue
  );
  const s = Math.cbrt(
    0.088_302_461_9 * linearRed +
      0.281_718_837_6 * linearGreen +
      0.629_978_700_5 * linearBlue
  );
  const a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
  const b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
  return {
    a,
    b,
    chroma: Math.sqrt(a * a + b * b),
    lightness: 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
  };
}

function srgbToLinear(value: number): number {
  if (value <= 0.040_45) {
    return value / 12.92;
  }
  return ((value + 0.055) / 1.055) ** 2.4;
}

function parseNumberOrPercent(value: string): number {
  if (value.endsWith("%")) {
    return Number(value.slice(0, -1)) / 100;
  }
  return Number(value);
}

function oklabDistance(first: OklabPoint, second: OklabPoint): number {
  return Math.sqrt(
    (first.lightness - second.lightness) ** 2 +
      (first.a - second.a) ** 2 +
      (first.b - second.b) ** 2
  );
}

type OklabPoint = {
  lightness: number;
  chroma: number;
  a: number;
  b: number;
};

const COLOR_CONFLICT_DISTANCE = 0.075;
const EXACT_MATCH_DISTANCE = 0.001;
const MIN_CONFLICT_CHROMA = 0.08;
const hexPattern = /^#(?<hex>[a-f0-9]{6})$/i;
const oklchPattern =
  /^oklch\(\s*(?<lightness>[\d.]+%?)\s+(?<chroma>[\d.]+)\s+(?<hue>[\d.]+|none)(?:\s*\/\s*[\d.]+%?)?\s*\)$/;
const rgbPattern =
  /^rgb\(\s*(?<red>\d+)\s+(?<green>\d+)\s+(?<blue>\d+)(?:\s*\/\s*[\d.]+%?)?\s*\)$/;
