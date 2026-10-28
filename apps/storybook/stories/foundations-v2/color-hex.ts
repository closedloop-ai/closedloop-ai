/**
 * Foundations shows every colour as hex (Nerys, 2026-10-06), but
 * globals.css writes most tokens as `oklch(...)`, and a few as `rgb(...)` or
 * hex. This turns any of those into `#rrggbb`, or `#rrggbbaa` when the colour
 * is translucent, so the page can show one notation throughout.
 *
 * The conversion is done here rather than by the browser: a computed
 * `oklch()` colour stays `oklch()` when read back, so the DOM cannot do it.
 * OKLCH is converted through OKLab and linear sRGB (Björn Ottosson's
 * published matrices), and a colour outside the sRGB gamut is clipped
 * per channel, which is what the browser draws on an sRGB display too.
 *
 * Anything else (a `calc()`, a gradient, an unset token) comes back
 * unchanged, so the readout shows the real value rather than a wrong hex.
 */

const OKLCH_PATTERN =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/i;
const RGB_PATTERN =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/i;
const HEX_PATTERN = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

function alphaFrom(value: string | undefined, percent: string | undefined) {
  if (value === undefined) {
    return 1;
  }
  const alpha = Number(value);
  return percent ? alpha / 100 : alpha;
}

function channel(value: number) {
  const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
  return byte.toString(16).padStart(2, "0");
}

function hexFrom(red: number, green: number, blue: number, alpha: number) {
  const rgb = `#${channel(red)}${channel(green)}${channel(blue)}`;
  return alpha < 1 ? `${rgb}${channel(alpha)}` : rgb;
}

function gammaEncode(linear: number) {
  return linear <= 0.003_130_8
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055;
}

export function oklchToHex(
  lightness: number,
  chroma: number,
  hue: number,
  alpha = 1
) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);

  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;

  return hexFrom(
    gammaEncode(
      4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s
    ),
    gammaEncode(
      -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s
    ),
    gammaEncode(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
    alpha
  );
}

export function toHex(value: string) {
  const trimmed = value.trim();

  const oklch = trimmed.match(OKLCH_PATTERN);
  if (oklch) {
    const [, lightness, lightnessPercent, chroma, hue, alpha, alphaPercent] =
      oklch;
    return oklchToHex(
      Number(lightness) / (lightnessPercent ? 100 : 1),
      Number(chroma),
      Number(hue),
      alphaFrom(alpha, alphaPercent)
    );
  }

  const rgb = trimmed.match(RGB_PATTERN);
  if (rgb) {
    const [, red, green, blue, alpha, alphaPercent] = rgb;
    return hexFrom(
      Number(red) / 255,
      Number(green) / 255,
      Number(blue) / 255,
      alphaFrom(alpha, alphaPercent)
    );
  }

  const hex = trimmed.match(HEX_PATTERN);
  if (hex) {
    const digits = hex[1].toLowerCase();
    const full =
      digits.length <= 4
        ? [...digits].map((digit) => `${digit}${digit}`).join("")
        : digits;
    return full.endsWith("ff") && full.length === 8
      ? `#${full.slice(0, 6)}`
      : `#${full}`;
  }

  return trimmed;
}
