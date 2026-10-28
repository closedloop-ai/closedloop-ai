import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Inbox and Comments stories render Liveblocks' own chrome, which is styled
 * ONLY by `@liveblocks/react-ui/styles.css`. `packages/collaboration` imports
 * that beside its sibling `./inbox.css`, which is enough in apps/app and is NOT
 * enough here: found under `@storybook/nextjs`'s webpack builder, which emitted
 * the workspace package's relative stylesheet and DROPPED a global stylesheet
 * reached through a node_modules specifier — from the component and from
 * `preview.tsx` alike, with no error either way. The preview then carried the
 * whole `--lb-*` bridge with nothing underneath it and every row rendered as
 * unstyled markup. The fix (the `@import` in `storybook.css` this test pins)
 * still holds under `@storybook/nextjs-vite`, the builder ISS-10257 migrated
 * to — untested here is whether Vite would have dropped it too, only that
 * routing it through Tailwind's PostCSS pass avoids the question.
 *
 * The portable-stories sweep cannot see this: it mounts and plays in jsdom and
 * asserts text and roles, so a story with no CSS at all still passes. Hence a
 * test over the CSS entry rather than over a render.
 */

// `import.meta.dirname`, as the sibling catalog test does: this suite's
// `import.meta.url` is not a `file:` URL under Storybook's vitest config.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DESIGN_SYSTEM_ROOT = path.join(REPO_ROOT, "packages/design-system");
// Resolve from the CSS entry's OWN package, because that is the directory
// Tailwind's PostCSS pass resolves the `@import` from — so it is
// `packages/design-system`'s manifest that has to declare the dependency, not
// the workspace root's. Resolving from the root instead reaches pnpm's hoisted
// store, which three other packages already populate, and dropping the
// devDependency would leave this green while every story rendered unstyled.
const require = createRequire(path.join(DESIGN_SYSTEM_ROOT, "package.json"));
const STORYBOOK_CSS_ENTRY = path.join(
  DESIGN_SYSTEM_ROOT,
  "styles/storybook.css"
);
const LIVEBLOCKS_IMPORT = '@import "@liveblocks/react-ui/styles.css";';
/** The base row rule. Present iff this really is the stylesheet we mean. */
const ROW_RULE = ".lb-inbox-notification";

describe("the Storybook preview's Liveblocks stylesheet", () => {
  it("is imported by the CSS entry, where PostCSS inlines it", () => {
    // An `@import` here and not a JS import anywhere: Tailwind's PostCSS pass
    // resolves and inlines it before the JS bundler (webpack, then Vite since
    // ISS-10257) ever sees the specifier, so whatever that bundler does with a
    // node_modules stylesheet reference never applies.
    expect(readFileSync(STORYBOOK_CSS_ENTRY, "utf8")).toContain(
      LIVEBLOCKS_IMPORT
    );
  });

  it("resolves, and is the stylesheet that styles the rows", () => {
    // Pins the referent, not the spelling: a version bump that relocates the
    // file, or an import of some other Liveblocks stylesheet, reddens here
    // rather than as six silently unstyled stories.
    const resolved = require.resolve("@liveblocks/react-ui/styles.css");

    expect(readFileSync(resolved, "utf8")).toContain(ROW_RULE);
  });
});
