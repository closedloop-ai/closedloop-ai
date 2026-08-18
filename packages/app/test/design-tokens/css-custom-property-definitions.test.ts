import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ISS-5613: a `var(--token)` with no fallback that names a custom property
 * nothing declares does not fall back to anything sensible — the declaration is
 * invalid at computed-value time and the property takes its INITIAL value. For
 * `border-radius` that is `0`, which is why every pill and status dot on Session
 * detail and the trace chips rendered as a square: they all consumed
 * `var(--radius-full)`, and no layer ever defined it.
 *
 * The trap is that the miss is invisible in review. Tailwind's default theme
 * ships `--radius-xs … --radius-4xl` and `--shadow-sm`/`--shadow-lg`, and the
 * design system re-declares `--radius-sm`/`-md`/`-lg`/`-xl` on top, so the
 * sibling lines directly above and below the broken one resolve fine. Only
 * `--radius-full` was absent, because `rounded-full` is a STATIC Tailwind
 * utility rather than a theme key, so no `--radius-full` variable exists to
 * inherit. Nothing failed; the corners just went square.
 *
 * So this asserts the invariant rather than the one token: every custom property
 * these stylesheets consume without a fallback must actually be declared by a
 * layer that ships with them, AT A SCOPE THAT REACHES THE CONSUMER.
 *
 * That last clause is load-bearing (#4943 review). Counting a declaration in ANY
 * rule as "defined" would let `.owner { --token: 8px }` satisfy an unrelated
 * `.consumer { width: var(--token) }`, which computes with an undefined variable
 * — the exact defect class this file exists to catch, waved through. Custom
 * properties inherit DOWNWARD, so only a declaration on a global root (`:root`,
 * `html`, `*`, or a Tailwind `@theme` block, which compiles to `:root`) is
 * reachable from anywhere. `packages/app` genuinely does declare selector-local
 * properties, so those are enumerated in `SCOPED_PROPERTIES` below with the
 * owner whose subtree makes them reachable — hand-verified against the DOM,
 * because no stylesheet states that `.sd3-bars2` renders inside `.sd3`.
 */

const APP_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DESIGN_SYSTEM_GLOBALS = path.resolve(
  APP_ROOT,
  "..",
  "design-system",
  "styles",
  "globals.css"
);

/**
 * Selector-local custom properties in `packages/app`, mapped to the selector
 * that declares them. A consumer is only satisfied by one of these if it renders
 * inside that owner's subtree — a fact the CSS cannot state, so each entry is
 * verified against the component that mounts it and named here deliberately. A
 * new selector-local property fails this suite until it is added, which is the
 * point: the ancestry has to be looked at by a person once.
 *
 *  - `.sd3` wraps the whole Session-detail screen
 *    (`agent-session-detail-view.tsx`), so every `sd3-*` rule is inside it.
 *  - `.sd3-bars2-wrap` is that view's Session-Timeline strip wrapper, and the
 *    bars, the axis and the `.tl-here` marker are all its descendants.
 */
const SCOPED_PROPERTIES: Readonly<Record<string, string>> = {
  "--sd3-cmts-w": ".sd3",
  "--sd3-sticky-clearance": ".sd3",
  "--sd3-bars2-height": ".sd3-bars2-wrap",
  "--sd3-bars2-inner-height": ".sd3-bars2-wrap",
  "--sd3-bars2-pad-top": ".sd3-bars2-wrap",
  "--sd3-bars2-rule": ".sd3-bars2-wrap",
};

/**
 * `var(--foo)` / `var( --foo )` only. The trailing `)` is load-bearing: a
 * `var(--foo, 8px)` carries its own fallback, so an undeclared name there is a
 * deliberate default and not the defect this guards.
 */
const VAR_REFERENCE_WITHOUT_FALLBACK = /var\(\s*(--[\w-]+)\s*\)/g;

/** The `--radius-full` declaration this ticket adds, and its value. */
const RADIUS_FULL_DECLARATION = /^\s*--radius-full\s*:\s*([^;]+);/m;

/** One flat `selector { body }` rule. These stylesheets do not nest. */
const CSS_RULE = /([^{}]+)\{([^{}]*)\}/g;

const BORDER_RADIUS_DECLARATION = /(?:^|;)\s*border-radius\s*:\s*([^;}]+)/;

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

const CUSTOM_PROPERTY_NAME = /^(--[\w-]+)\s*:/;

/** Roots every element inherits from. A `@theme` block compiles to `:root`. */
const GLOBAL_ROOT_SELECTOR = /^(:root|html|\*|::backdrop)$/;

/** At-rules that wrap rules without changing which element they match. */
const TRANSPARENT_AT_RULE = /^@(media|supports|layer|container|scope)\b/;

const THEME_AT_RULE = /^@theme\b/;

/**
 * Tailwind's default theme is a definition source these stylesheets legitimately
 * draw on — `@import "tailwindcss"` emits it into the same `:root`. It resolves
 * from the design system (which owns the dependency), not from here.
 */
function readTailwindDefaultTheme(): string {
  const fromDesignSystem = createRequire(
    createRequire(path.join(APP_ROOT, "package.json")).resolve(
      "@repo/design-system/package.json"
    )
  );
  return readFileSync(
    fromDesignSystem.resolve("tailwindcss/theme.css"),
    "utf8"
  );
}

function stripComments(css: string): string {
  return css.replace(CSS_COMMENT, "");
}

function isGlobalScope(preludes: readonly string[]): boolean {
  for (let index = preludes.length - 1; index >= 0; index--) {
    const prelude = preludes[index];
    if (TRANSPARENT_AT_RULE.test(prelude)) {
      continue;
    }
    if (THEME_AT_RULE.test(prelude)) {
      return true;
    }
    // A selector LIST is global when any part of it is: that part alone puts the
    // declaration on the root, e.g. `:root, .dark { --x: … }`.
    return prelude
      .split(",")
      .some((part) => GLOBAL_ROOT_SELECTOR.test(part.trim()));
  }
  return false;
}

/**
 * Walks the brace structure so each declaration is attributed to the rule that
 * actually holds it. A regex over whole-file text cannot do this — it is exactly
 * what conflated `.owner { --x: … }` with a root declaration.
 */
function collectDeclarations(css: string): {
  global: Set<string>;
  scoped: Map<string, Set<string>>;
} {
  const global = new Set<string>();
  const scoped = new Map<string, Set<string>>();
  const preludes: string[] = [];
  let buffer = "";

  const record = () => {
    const name = buffer.trim().match(CUSTOM_PROPERTY_NAME)?.[1];
    buffer = "";
    if (name === undefined) {
      return;
    }
    if (isGlobalScope(preludes)) {
      global.add(name);
      return;
    }
    const owner = preludes.at(-1)?.replace(/\s+/g, " ").trim() ?? "";
    const owners = scoped.get(name) ?? new Set<string>();
    owners.add(owner);
    scoped.set(name, owners);
  };

  for (const character of stripComments(css)) {
    if (character === "{") {
      preludes.push(buffer.trim());
      buffer = "";
    } else if (character === "}") {
      record();
      preludes.pop();
    } else if (character === ";") {
      record();
    } else {
      buffer += character;
    }
  }
  return { global, scoped };
}

describe("design-token custom properties", () => {
  const appStylesheets = readdirSync(APP_ROOT, {
    recursive: true,
    encoding: "utf8",
  })
    .filter(
      (entry) => entry.endsWith(".css") && !entry.includes("node_modules")
    )
    .map((entry) => path.join(APP_ROOT, entry))
    .sort();

  const globallyDeclared = new Set<string>();
  const scopedDeclarations = new Map<string, Set<string>>();
  for (const source of [
    ...appStylesheets.map((file) => readFileSync(file, "utf8")),
    readFileSync(DESIGN_SYSTEM_GLOBALS, "utf8"),
    readTailwindDefaultTheme(),
  ]) {
    const { global, scoped } = collectDeclarations(source);
    for (const name of global) {
      globallyDeclared.add(name);
    }
    for (const [name, owners] of scoped) {
      const merged = scopedDeclarations.get(name) ?? new Set<string>();
      for (const owner of owners) {
        merged.add(owner);
      }
      scopedDeclarations.set(name, merged);
    }
  }

  it("finds the app stylesheets it is meant to guard", () => {
    expect(appStylesheets.length).toBeGreaterThan(0);
    expect(globallyDeclared.has("--radius-sm")).toBe(true);
  });

  /*
   * The scope split is only trustworthy if it actually splits. If every
   * declaration were classified global, the assertion below would be the same
   * permissive check it replaced and would pass through the false negative it
   * was added to close.
   */
  it("classifies a selector-local declaration as scoped, not global", () => {
    for (const [name, owner] of Object.entries(SCOPED_PROPERTIES)) {
      expect(globallyDeclared.has(name)).toBe(false);
      expect(Array.from(scopedDeclarations.get(name) ?? [])).toEqual([owner]);
    }
  });

  it("declares every custom property the app stylesheets consume without a fallback", () => {
    const unreachable = appStylesheets.flatMap((file) => {
      const css = stripComments(readFileSync(file, "utf8"));
      return Array.from(css.matchAll(VAR_REFERENCE_WITHOUT_FALLBACK))
        .map((match) => match[1])
        .filter(
          (name) => !(globallyDeclared.has(name) || name in SCOPED_PROPERTIES)
        )
        .map(
          (name) => `${path.relative(APP_ROOT, file)} consumes var(${name})`
        );
    });

    expect(Array.from(new Set(unreachable)).sort()).toEqual([]);
  });

  it("gives --radius-full the same value rounded-full compiles to", () => {
    const globals = stripComments(readFileSync(DESIGN_SYSTEM_GLOBALS, "utf8"));
    const declaration = globals.match(RADIUS_FULL_DECLARATION);

    // Tailwind compiles `rounded-full` to this literal. Pinning the token to it
    // keeps a CSS `var(--radius-full)` and a `rounded-full` utility from
    // becoming two different "fully rounded" radii.
    expect(declaration?.[1].trim()).toBe("calc(infinity * 1px)");
    // And it has to be reachable from every consumer, not merely present.
    expect(globallyDeclared.has("--radius-full")).toBe(true);
  });

  /*
   * `.sd3-status-dot` is shared by Session detail and Branch detail, and the two
   * screens round it DIFFERENTLY on purpose (wongk, #4943): the handed-off
   * Branch prototype styles both of its dots `rounded-[0.1875rem]`, so Branch's
   * approved shape is a 3px rounded square while Session's is a circle. Pinning
   * the whole set rather than demanding one radius keeps that deliberate
   * divergence legible and still fails on the regression this ticket is about —
   * the base rule ceasing to round from the token, or a THIRD surface quietly
   * acquiring its own literal radius for the same dot.
   */
  it("rounds the status dot from the token, with only the surfaces that opt out", () => {
    const radii = appStylesheets.flatMap((file) => {
      const css = stripComments(readFileSync(file, "utf8"));
      return Array.from(css.matchAll(CSS_RULE))
        .filter(([, selector]) => selector.includes(".sd3-status-dot"))
        .flatMap(([, selector, body]) => {
          const declared = body.match(BORDER_RADIUS_DECLARATION);
          return declared == null
            ? []
            : [`${selector.trim()} → ${declared[1].trim()}`];
        });
    });

    expect(radii.sort()).toEqual([
      ".bq-props .sd3-status-dot → 0.1875rem",
      ".sd3-status-dot → var(--radius-full)",
    ]);
  });
});
