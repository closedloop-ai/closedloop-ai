/**
 * Reads design-system theme tokens straight out of `globals.css` (ISS-5335).
 *
 * WHY THIS IS A SEPARATE MODULE, and why the name ends in `.node`: this reads
 * the filesystem, so it must never end up in a browser-context type graph.
 * `contrast.ts` is imported by the desktop RENDERER's test suite, whose tsconfig
 * has no Node types — folding this into that file made `tsc -p
 * tsconfig.renderer.json` fail on `Cannot find module 'node:fs'`. Only tests
 * that already run in a Node context may import this module; everything that
 * needs to work in the renderer stays in `contrast.ts`.
 *
 * WHY PARSE THE STYLESHEET AT ALL: the alternative is a hand-copied table of
 * token values, which is SSOT-drift-by-copy. A token can be re-tuned in the
 * stylesheet — `--chart-2` and `--chart-3` were, precisely for legibility —
 * while a copied table keeps every contrast assertion measuring the stale value
 * and green. Parsing means the assertions measure the palette that ships.
 *
 * This is a parse, not a raw-text scan: nothing asserts on the file's text, and
 * a stylesheet is a declarative data file, not TypeScript source.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { A11yTheme, parseCssColor } from "./contrast";

const GLOBALS_CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../design-system/styles/globals.css"
);

const THEME_BLOCK_SELECTORS = {
  [A11yTheme.Light]: ":root",
  [A11yTheme.Dark]: ".dark",
} as const;

const CUSTOM_PROPERTY_PATTERN =
  /^\s*(?<name>--[a-z0-9-]+)\s*:\s*(?<value>[^;]+);\s*$/i;
const VAR_REFERENCE_PATTERN = /^var\(\s*(?<name>--[a-z0-9-]+)\s*\)$/i;
const COLOR_MIX_WITH_TRANSPARENT_PATTERN =
  /^color-mix\(\s*in\s+[a-z0-9-]+\s*,\s*(?<color>.+?)\s+(?<percent>[\d.]+)%\s*,\s*transparent\s*\)$/i;

const MAX_VAR_INDIRECTION_DEPTH = 10;

const themeTokenCache = new Map<A11yTheme, ReadonlyMap<string, string>>();

/** The declared value of `name` in `theme`'s block, e.g. `oklch(0.989 0 0)`. */
export function themeToken(theme: A11yTheme, name: string): string {
  const value = loadThemeTokens(theme).get(name);
  if (value === undefined) {
    throw new Error(
      `Theme token ${name} is not declared in the ${THEME_BLOCK_SELECTORS[theme]} block of globals.css`
    );
  }
  return value;
}

/**
 * Resolves an authored CSS colour expression to a concrete colour for `theme`.
 *
 * Handles the two indirections the product's colour maps actually author:
 * `var(--token)` (including a token whose own value is another `var()`), and
 * `color-mix(in <space>, <colour> N%, transparent)`, which per CSS Color 5
 * premultiplied mixing yields the colour at `N%` of its original alpha.
 *
 * Anything else THROWS rather than passing through. A colour form this cannot
 * measure must fail loudly — a silent passthrough would let an unmeasurable
 * value slip past a contrast floor while the assertion still read as green.
 */
export function resolveThemeColor(theme: A11yTheme, value: string): string {
  return resolveThemeColorAtDepth(theme, value, 0);
}

function resolveThemeColorAtDepth(
  theme: A11yTheme,
  value: string,
  depth: number
): string {
  if (depth > MAX_VAR_INDIRECTION_DEPTH) {
    throw new Error(`Cyclic or too-deep CSS colour indirection: ${value}`);
  }

  const trimmed = value.trim();

  const varMatch = trimmed.match(VAR_REFERENCE_PATTERN);
  if (varMatch?.groups) {
    return resolveThemeColorAtDepth(
      theme,
      themeToken(theme, varMatch.groups.name),
      depth + 1
    );
  }

  const mixMatch = trimmed.match(COLOR_MIX_WITH_TRANSPARENT_PATTERN);
  if (mixMatch?.groups) {
    const base = parseCssColor(
      resolveThemeColorAtDepth(theme, mixMatch.groups.color, depth + 1)
    );
    const alpha = base.alpha * (Number(mixMatch.groups.percent) / 100);
    return `rgba(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)}, ${alpha})`;
  }

  if (trimmed.startsWith("var(") || trimmed.startsWith("color-mix(")) {
    throw new Error(`Unsupported CSS colour expression: ${value}`);
  }

  return trimmed;
}

function loadThemeTokens(theme: A11yTheme): ReadonlyMap<string, string> {
  const cached = themeTokenCache.get(theme);
  if (cached) {
    return cached;
  }
  const parsed = parseThemeBlock(
    readFileSync(GLOBALS_CSS_PATH, "utf8"),
    THEME_BLOCK_SELECTORS[theme]
  );
  themeTokenCache.set(theme, parsed);
  return parsed;
}

function parseThemeBlock(
  css: string,
  selector: string
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  let depth = 0;
  let inBlock = false;

  for (const line of css.split("\n")) {
    if (!inBlock) {
      if (line.trim() === `${selector} {`) {
        inBlock = true;
        depth = 1;
      }
      continue;
    }

    const match = line.match(CUSTOM_PROPERTY_PATTERN);
    if (match?.groups) {
      // Last declaration wins, matching the cascade.
      tokens.set(match.groups.name, match.groups.value.trim());
    }

    depth += countChar(line, "{") - countChar(line, "}");
    if (depth <= 0) {
      break;
    }
  }

  if (tokens.size === 0) {
    throw new Error(
      `No custom properties parsed from the ${selector} block of ${GLOBALS_CSS_PATH}`
    );
  }
  return tokens;
}

function countChar(line: string, char: string): number {
  let total = 0;
  for (const current of line) {
    if (current === char) {
      total += 1;
    }
  }
  return total;
}
