import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ISS-10022: `client/inbox.css` is the ONLY bridge between Liveblocks' own row
 * chrome — the inbox "More" trigger, its tooltip, its dropdown — and this
 * product's tokens. Nothing renders those surfaces from our components, so a
 * token left undeclared or mapped to the wrong role is invisible to every
 * component test and shows up only as an unstyled menu in the running app.
 * These assertions are over the stylesheet text for that reason.
 */

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Comments are prose ABOUT declarations and must never be read as declarations.
 * `inbox.css` explains a Liveblocks default in the ISS-5010 note as
 * "--lb-foreground-moderate: roughly 8% foreground …" — a token name, a colon
 * and a sentence, which every scan below would otherwise take for a real
 * mapping carrying a literal. Stripping first also stops a token named only in
 * prose from satisfying the undeclared-token check.
 */
function withoutComments(css: string): string {
  return css.replace(CSS_COMMENT, "\n");
}

const require = createRequire(import.meta.url);
const LIVEBLOCKS_STYLESHEET = withoutComments(
  readFileSync(require.resolve("@liveblocks/react-ui/styles.css"), "utf8")
);
const INBOX_STYLESHEET = withoutComments(
  readFileSync(
    fileURLToPath(new URL("../client/inbox.css", import.meta.url)),
    "utf8"
  )
);

/** `--lb-x: …`, anywhere in a stylesheet. */
const TOKEN_DECLARATION = /(--lb-[a-z0-9-]+)\s*:/g;

/**
 * `var(--lb-x)` with NO fallback — the only form that renders the whole
 * declaration invalid at computed-value time when the token is missing.
 * `var(--lb-x, …)` degrades to its fallback and is not a defect.
 */
const TOKEN_REFERENCE_WITHOUT_FALLBACK = /var\(\s*(--lb-[a-z0-9-]+)\s*\)/g;

const TOKEN_DECLARATION_WITH_VALUE = /(--lb-[a-z0-9-]+)\s*:([^;]+);/g;

/** A `var(--x)` reference to anything that is NOT another Liveblocks token. */
const DESIGN_SYSTEM_VAR_REFERENCE = /var\(\s*--(?!lb-)[a-z0-9-]+[^)]*\)/i;
/** Every `var(…)` group, so a value can be reduced to what surrounds them. */
const ANY_VAR_REFERENCE = /var\([^()]*\)/g;
/**
 * A bare word in that remainder — `red`, `color`, `lab`, `fff`. The lookbehind
 * has to exclude letters as well as digits: guarding only `[0-9.]` skips the
 * `p` of `1px` and then matches its `x`. A `#` is checked separately, because
 * `#00000014` carries no letters at all.
 */
const BARE_WORD = /(?<![0-9.a-z-])[a-z][a-z0-9-]*/gi;
/** Words that carry no colour: CSS structure, not a value. */
const STRUCTURAL_KEYWORDS = new Set(["inset", "calc", "min", "max", "clamp"]);

const TOOLTIP_RULE = /\.lb-root:where\(\.lb-tooltip\)\s*\{([^}]*)\}/;
const ELEVATION_RULE = /\.lb-root:where\(\.lb-elevation\)\s*\{([^}]*)\}/;
/** Each `.lb-root:where(…)` selector, captured as its raw argument list. */
const LB_ROOT_WHERE_SELECTOR = /\.lb-root:where\(([^)]*)\)/g;

/**
 * Set inline by `AvatarStack`, a Liveblocks component this repo never mounts,
 * so no stylesheet declares them and no surface here can be missing one.
 */
const TOKENS_SET_BY_LIVEBLOCKS_AT_RUNTIME = [
  "--lb-avatar-stack-count",
  "--lb-avatar-stack-avatar-index",
];

function declaredTokens(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(TOKEN_DECLARATION), (m) => m[1]));
}

/**
 * Whatever a declaration says once every `var(…)` is taken out of it. What is
 * left must be structure — lengths, keywords — never a colour in any notation.
 */
function colourLiteralsOutsideVars(value: string): string[] {
  const remainder = value.replace(ANY_VAR_REFERENCE, " ");
  const words = Array.from(remainder.matchAll(BARE_WORD), (m) => m[0]).filter(
    (word) => !STRUCTURAL_KEYWORDS.has(word.toLowerCase())
  );
  return remainder.includes("#") ? [...words, "#"] : words;
}

/**
 * `.lb-root:where(…)` selectors naming BOTH elevated surfaces and tooltips, in
 * either order — one rule matching both is what put the tooltip on the popover
 * colours to begin with.
 */
function selectorsCombiningElevationAndTooltip(css: string): string[] {
  return Array.from(css.matchAll(LB_ROOT_WHERE_SELECTOR), (m) => m[1])
    .filter(
      (args) => args.includes(".lb-elevation") && args.includes(".lb-tooltip")
    )
    .map((args) => args.trim());
}

describe("Liveblocks theme bridge (client/inbox.css)", () => {
  it("leaves no token Liveblocks paints with undeclared", () => {
    const declared = new Set([
      ...declaredTokens(LIVEBLOCKS_STYLESHEET),
      ...declaredTokens(INBOX_STYLESHEET),
    ]);
    const referenced = new Set(
      Array.from(
        LIVEBLOCKS_STYLESHEET.matchAll(TOKEN_REFERENCE_WITHOUT_FALLBACK),
        (m) => m[1]
      )
    );

    const undeclared = Array.from(referenced)
      .filter((token) => !declared.has(token))
      .filter((token) => !TOKENS_SET_BY_LIVEBLOCKS_AT_RUNTIME.includes(token))
      .sort();

    expect(undeclared).toEqual([]);
  });

  it("declares --lb-inset-shadow, which ships only in Liveblocks' dark sheet", () => {
    // The edge of `.lb-elevation::after` / `.lb-tooltip::after`. Liveblocks
    // declares it in `styles/dark/attributes.css` alone, which nothing here
    // imports — so without our declaration the "More" menu has no border.
    expect(declaredTokens(LIVEBLOCKS_STYLESHEET)).not.toContain(
      "--lb-inset-shadow"
    );
    expect(declaredTokens(INBOX_STYLESHEET)).toContain("--lb-inset-shadow");
  });

  it("maps every --lb-* token to a design-system variable, never a literal", () => {
    // Stated as what a value MUST be, not as a list of colour notations to
    // reject: `red`, `color(display-p3 …)` and `lab()` are colours too, and a
    // blocklist that has not heard of them passes them through.
    const declarations = Array.from(
      INBOX_STYLESHEET.matchAll(TOKEN_DECLARATION_WITH_VALUE),
      ([, token, value]) => ({ token, value })
    );
    expect(declarations.length).toBeGreaterThan(0);

    const withoutDesignSystemVar = declarations
      .filter(({ value }) => !DESIGN_SYSTEM_VAR_REFERENCE.test(value))
      .map(({ token }) => token);
    expect(withoutDesignSystemVar).toEqual([]);

    const carryingALiteral = declarations
      .filter(({ value }) => colourLiteralsOutsideVars(value).length > 0)
      .map(({ token }) => token);
    expect(carryingALiteral).toEqual([]);
  });

  it.each([
    ["a hex literal", "--lb-background: #fff;"],
    [
      "an alpha hex with no letters",
      "--lb-elevation-shadow: 0 0 0 1px #00000014;",
    ],
    ["a named colour", "--lb-foreground: red;"],
    ["a colour() literal", "--lb-accent: color(display-p3 1 0 0);"],
    ["a lab() literal", "--lb-accent: lab(50% 40 59.5);"],
    [
      "a literal beside a variable",
      "--lb-inset-shadow: inset 0 0 0 1px black;",
    ],
  ])("rejects %s", (_label, declaration) => {
    const value = declaration.split(":")[1];

    expect(colourLiteralsOutsideVars(value).length).toBeGreaterThan(0);
  });

  it("accepts a length-and-variable value as structure, not colour", () => {
    expect(colourLiteralsOutsideVars(" inset 0 0 0 1px var(--border)")).toEqual(
      []
    );
    expect(
      colourLiteralsOutsideVars(" calc(.5em + 2px) var(--popover)")
    ).toEqual([]);
  });

  it("keeps tooltips inverted rather than on the popover surface", () => {
    // `TooltipContent` is `bg-foreground text-background`; Liveblocks' own
    // `.lb-tooltip` ships `#222`/`#fff` for the same reason. Folding tooltips
    // in with `.lb-elevation` overrode both.
    const tooltipRule = INBOX_STYLESHEET.match(TOOLTIP_RULE)?.[1];

    expect(tooltipRule).toBeDefined();
    expect(tooltipRule).toContain("--lb-background: var(--foreground)");
    expect(tooltipRule).toContain("--lb-foreground: var(--background)");
    expect(selectorsCombiningElevationAndTooltip(INBOX_STYLESHEET)).toEqual([]);
  });

  it.each([
    [
      ".lb-root:where(.lb-elevation, .lb-tooltip) { --lb-background: var(--popover); }",
    ],
    [
      ".lb-root:where(.lb-tooltip, .lb-elevation) { --lb-background: var(--popover); }",
    ],
  ])("catches a combined selector in either order: %s", (rule) => {
    // `:where()` is unordered, so a rule reinstating the shared treatment can
    // spell its arguments either way round and mean exactly the same thing.
    expect(selectorsCombiningElevationAndTooltip(rule)).toHaveLength(1);
  });

  it("puts elevated surfaces on the popover pair DropdownMenu uses", () => {
    const elevationRule = INBOX_STYLESHEET.match(ELEVATION_RULE)?.[1];

    expect(elevationRule).toBeDefined();
    expect(elevationRule).toContain("--lb-background: var(--popover)");
    expect(elevationRule).toContain(
      "--lb-foreground: var(--popover-foreground)"
    );
  });
});
