/**
 * Every Screen exposes the same shape of controls.
 *
 * A screen story is the one place a designer can see the whole page and poke at
 * it. That only works if the Controls panel is actually populated, and screens
 * are the easiest stories to leave empty: the component is a local wrapper the
 * story author writes, so unlike a design-system primitive there is no prop
 * surface for docgen to infer. Every control on a screen has to be authored
 * deliberately, which means it is also easy to skip.
 *
 * All three screens started that way. They were `controls: { disable: true }`
 * with zero-prop components, so the panel was empty by construction.
 *
 * The shape that works, taken from Login:
 *
 *   - Content     the copy: headings, labels, button text
 *   - Composition a boolean per major region, so you can see the page with a
 *                 panel missing the way a real user with fewer permissions or
 *                 less data would
 *   - State       loading, pending, error
 *   - Shell       which nav destination reads as current
 *
 * The rules below enforce the structure, not the taste. They cannot tell you
 * the controls are useful; they can tell you the panel is not empty, that every
 * control is filed under a heading, and that none of them render blank.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCREENS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "stories",
  "surfaces"
);

// Only story files. `app-shell.tsx` is a shared helper, not a screen.
const STORY_SUFFIX = ".stories.tsx";

const AUTODOCS = /tags:\s*\[[^\]]*"autodocs"/;
const CONTROLS_DISABLED = /controls:\s*\{\s*disable:\s*true/;
const ARGTYPES_BLOCK = /\n {2}argTypes:\s*\{([\s\S]*?)\n {2}\},/;
const ARGS_BLOCK = /\n {2}args:\s*\{([\s\S]*?)\n {2}\},/;
const TOP_LEVEL_KEY = /^ {4}([A-Za-z_$][\w$]*)\s*:/gm;
const CATEGORY = /table:\s*\{[^}]*category:/;

function screenStories(): string[] {
  return readdirSync(SCREENS_DIR)
    .filter((f) => f.endsWith(STORY_SUFFIX))
    .map((f) => join(SCREENS_DIR, f));
}

/** The keys declared inside a `argTypes` / `args` block, with their bodies. */
function entries(block: string | undefined): Map<string, string> {
  const found = new Map<string, string>();
  if (!block) {
    return found;
  }
  const keys = [...block.matchAll(TOP_LEVEL_KEY)];
  for (const [i, match] of keys.entries()) {
    const start = match.index ?? 0;
    const end = keys[i + 1]?.index ?? block.length;
    found.set(match[1], block.slice(start, end));
  }
  return found;
}

describe("screens expose a full Controls panel", () => {
  const files = screenStories();

  it("finds screen stories to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = file.split("/").pop() ?? file;
    const source = readFileSync(file, "utf8");
    const argTypes = entries(source.match(ARGTYPES_BLOCK)?.[1]);
    const args = entries(source.match(ARGS_BLOCK)?.[1]);

    describe(name, () => {
      it("does not disable controls", () => {
        expect(
          CONTROLS_DISABLED.test(source),
          "A screen with `controls: { disable: true }` shows an empty panel. If the screen genuinely has nothing to vary, it is probably not finished."
        ).toBe(false);
      });

      it("is documented with autodocs", () => {
        expect(AUTODOCS.test(source), 'Add tags: ["autodocs"].').toBe(true);
      });

      it("declares argTypes", () => {
        expect(
          argTypes.size,
          "A screen's component is a wrapper the story author writes, so docgen infers nothing. Every control has to be declared."
        ).toBeGreaterThan(0);
      });

      it("files every control under a category", () => {
        const uncategorised = [...argTypes]
          .filter(([, body]) => !CATEGORY.test(body))
          .map(([key]) => key);
        expect(
          uncategorised,
          'Screens carry enough controls that an unsorted list is hard to scan. Use table: { category: "Content" | "Composition" | "State" | "Shell" }.'
        ).toEqual([]);
      });

      it("gives every control an initial value", () => {
        const empty = [...argTypes.keys()].filter((key) => !args.has(key));
        expect(
          empty,
          "A control with no matching arg renders blank and reads as broken. Every argType on a screen needs a value in meta args."
        ).toEqual([]);
      });

      it("offers a Composition control per major region", () => {
        const composition = [...argTypes.keys()].filter((key) =>
          key.startsWith("show")
        );
        expect(
          composition.length,
          "Screens should let a reviewer drop each major region, so they can see the page the way a user with less data or fewer permissions gets it. Name them show<Region>."
        ).toBeGreaterThan(0);
      });
    });
  }
});
