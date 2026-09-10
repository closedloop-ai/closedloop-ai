/**
 * Screens compose the design system; they do not restyle it.
 *
 * The Screens section exists to show how the real parts add up. That only works
 * if the parts look like themselves. A screen that hand-colors a component is
 * showing a thing the product does not contain, and it does it silently: the
 * component still renders, the story still passes the sweep, and the screenshot
 * just quietly disagrees with that component's own story two sections up in the
 * sidebar.
 *
 * That is exactly what happened to the dashboard's status column. It imported
 * the real `Badge`, then passed `bg-success text-success-foreground` through
 * `className`. `Badge` merges `className` last, so those beat the variant
 * classes, and full-strength `bg-success` beat the `bg-success/12` tint every
 * other status pill in the catalog uses. The result was a row of solid saturated
 * pills that appear nowhere in the design system, sitting next to a Badge story
 * demonstrating the correct tints. It also dropped `ToneBadge`'s state dot, so
 * the status was left encoded in color alone.
 *
 * So: a component that owns a color vocabulary may receive layout and spacing
 * utilities through `className` (`w-full`, `p-0`, `lg:col-span-2` are all fine
 * and all in use), but never color. Color belongs to its variants. If a screen
 * needs a tone the component does not offer, the fix is a variant on the
 * component, not an override at the call site.
 *
 * Scope is derived, not listed, so it cannot fall out of date. A module owns a
 * color vocabulary when it either declares a `cva` block with a `variant` key
 * (`Badge`, `Button`) or computes a `variant` itself from its own prop
 * vocabulary (`ToneBadge`, which maps `tone` onto a Badge variant). `Input` and
 * `Table` do neither, so the app-shell search field styling itself
 * `bg-transparent focus-visible:bg-background` is not fighting anything and is
 * correctly left alone.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENS_DIR = join(HERE, "..", "stories", "surfaces");
const DESIGN_SYSTEM_ROOT = join(
  HERE,
  "..",
  "..",
  "..",
  "packages",
  "design-system"
);

/**
 * Semantic color tokens this design system defines, plus the raw Tailwind
 * palette. Deliberately NOT every `text-*` utility: `text-sm`, `text-right` and
 * `text-balance` are typography and alignment, not color, and screens use them
 * legitimately throughout.
 */
const SEMANTIC_TOKENS = [
  "primary",
  "secondary",
  "destructive",
  "success",
  "warning",
  "info",
  "accent",
  "muted",
  "foreground",
  "background",
  "card",
  "popover",
  "sidebar",
  "input",
  "border",
  "ring",
  "ai",
].join("|");

const PALETTE =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}";

// Biome's useTopLevelRegex: every pattern lives here, and every global one is
// consumed through `matchAll`, which clones rather than carrying `lastIndex`
// across the files we scan.
const COLOR_UTILITY = new RegExp(
  `\\b(?:bg|text|border|fill|stroke|ring|decoration)-(?:(?:${SEMANTIC_TOKENS})(?:-foreground)?(?:/\\d+)?|${PALETTE})\\b`,
  "g"
);
const DS_IMPORT_PREFIX = /^@repo\/design-system\//;
const CVA_CALL = /cva\(/;
const CVA_VARIANT_KEY = /variants:\s*\{[\s\S]*?\bvariant:/;
const COMPUTES_VARIANT = /variant=\{/;
const IMPORT_BLOCK =
  /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"(@repo\/design-system[^"]*)"/g;
const IMPORT_ALIAS = /\s+as\s+/;
const TOP_LEVEL_CONST = /^const\s+([A-Za-z_$][\w$]*)[^=]*=\s*([\s\S]*?);$/gm;
const STRING_LITERAL = /"([^"]*)"/g;
const JSX_OPEN_TAG =
  /<([A-Z][\w.]*)((?:[^>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*)\/?>/g;
const CLASSNAME_LITERAL = /className="([^"]*)"/;
const CLASSNAME_EXPRESSION = /className=\{([^}]*)\}/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

function screenFiles(): string[] {
  return readdirSync(SCREENS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(SCREENS_DIR, f));
}

/**
 * True when the module backing an import owns the color of what it renders,
 * either by declaring variants or by choosing one itself.
 */
function ownsColorVocabulary(importPath: string): boolean {
  const relative = importPath.replace(DS_IMPORT_PREFIX, "");
  for (const ext of [".tsx", ".ts"]) {
    let source: string;
    try {
      source = readFileSync(join(DESIGN_SYSTEM_ROOT, relative + ext), "utf8");
    } catch {
      continue;
    }
    return (
      (CVA_CALL.test(source) && CVA_VARIANT_KEY.test(source)) ||
      COMPUTES_VARIANT.test(source)
    );
  }
  return false;
}

/** Names imported from a design-system module that owns its color. */
function guardedImports(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(IMPORT_BLOCK)) {
    if (!ownsColorVocabulary(match[2])) {
      continue;
    }
    for (const raw of match[1].split(",")) {
      // Handles `Foo` and `Foo as Bar`; the local name is what appears in JSX.
      const local = raw.trim().split(IMPORT_ALIAS).pop()?.trim();
      if (local) {
        names.add(local);
      }
    }
  }
  return names;
}

/**
 * Every top-level `const NAME = ...` holding string literals, so a
 * `className={STATUS_TONE[x]}` indirection resolves back to the classes it
 * would apply. This is why the check caught the dashboard bug: the offending
 * classes were never written at the call site.
 */
function stringConstants(source: string): Map<string, string[]> {
  const consts = new Map<string, string[]>();
  for (const match of source.matchAll(TOP_LEVEL_CONST)) {
    const literals = [...match[2].matchAll(STRING_LITERAL)].map((m) => m[1]);
    if (literals.length > 0) {
      consts.set(match[1], literals);
    }
  }
  return consts;
}

/** Opening JSX tags for the given component names, with their raw attributes. */
function componentTags(
  source: string,
  names: Set<string>
): { name: string; attrs: string }[] {
  const found: { name: string; attrs: string }[] = [];
  for (const match of source.matchAll(JSX_OPEN_TAG)) {
    if (names.has(match[1])) {
      found.push({ name: match[1], attrs: match[2] });
    }
  }
  return found;
}

function colorViolations(source: string): string[] {
  const guarded = guardedImports(source);
  if (guarded.size === 0) {
    return [];
  }
  const consts = stringConstants(source);
  const violations: string[] = [];

  for (const { name, attrs } of componentTags(source, guarded)) {
    const literal = attrs.match(CLASSNAME_LITERAL);
    const expression = attrs.match(CLASSNAME_EXPRESSION);

    const candidates: string[] = [];
    if (literal) {
      candidates.push(literal[1]);
    }
    if (expression) {
      for (const ident of expression[1].matchAll(IDENTIFIER)) {
        const values = consts.get(ident[0]);
        if (values) {
          candidates.push(...values);
        }
      }
    }

    for (const value of candidates) {
      const hits = [...value.matchAll(COLOR_UTILITY)].map((m) => m[0]);
      if (hits.length > 0) {
        violations.push(
          `<${name}> receives color utilities via className: ${[...new Set(hits)].join(", ")}`
        );
      }
    }
  }

  return [...new Set(violations)];
}

describe("screens compose the design system without restyling it", () => {
  const files = screenFiles();

  it("finds screen sources to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  /**
   * A check that only ever passes is indistinguishable from no check. This
   * replays the exact shape of the original dashboard bug, indirection and all,
   * so the guard cannot quietly rot into a no-op if the regexes or the
   * vocabulary detection drift.
   */
  it("still catches the bug it was written for", () => {
    const regressed = [
      'import { Badge } from "@repo/design-system/components/ui/badge";',
      "const STATUS_TONE: Record<string, string> = {",
      '  Merged: "bg-success text-success-foreground",',
      "};",
      "const Row = () => <Badge className={STATUS_TONE.Merged}>Merged</Badge>;",
    ].join("\n");

    expect(colorViolations(regressed)).toEqual([
      "<Badge> receives color utilities via className: bg-success, text-success-foreground",
    ]);
  });

  it("leaves components without a color vocabulary alone", () => {
    const allowed = [
      'import { Input } from "@repo/design-system/components/ui/input";',
      'const Search = () => <Input className="bg-transparent focus-visible:bg-background" />;',
    ].join("\n");

    expect(colorViolations(allowed)).toEqual([]);
  });

  for (const file of files) {
    it(`${file.split("/").pop()} passes no color utilities to design-system components`, () => {
      expect(
        colorViolations(readFileSync(file, "utf8")),
        "Color belongs to the component's variant vocabulary, not to a className override at the call site. Use the component's variant or tone prop; if the tone you need does not exist, add it to the component."
      ).toEqual([]);
    });
  }
});
