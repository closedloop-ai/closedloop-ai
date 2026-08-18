/**
 * ISS-5287 — the all-stories sweep.
 *
 * Composes every story Storybook indexes and runs it. `Story.run()` mounts the
 * story AND executes its `play` function, so this file is not merely a
 * render smoke test: it is also the ONLY thing in this repo that executes a
 * story's `play` assertions. ISS-4517 authors interaction assertions as `play`
 * functions against these same story definitions and they are picked up here
 * automatically — do NOT add a second, parallel mechanism for running them.
 *
 * Before this existed, `apps/storybook/stories/ranked-bar.stories.tsx` had two
 * `play` functions with real `expect()` calls that nothing executed.
 *
 * The globs below are asserted against Storybook's own `stories` array by
 * `story-glob-parity.test.ts`, which reads BOTH lists from source — so neither a
 * new glob root in `main.ts` nor a deleted glob here can silently escape.
 */
import { composeStories } from "@storybook/react";
import { describe, expect, it } from "vitest";

type StoryModule = Parameters<typeof composeStories>[0];
type ComposedStory = { run: () => Promise<void> };

/**
 * Globals the story corpus installs on `window`, which every run in this file
 * shares. Five desktop stories `Object.defineProperty(window, "desktopApi", …)`
 * with narrow, MUTUALLY DISJOINT preload slices, and none restores it — so
 * without a restore between runs a story whose own fixture omits a method it
 * reads can pass on whatever the previously-run story happened to install, and
 * the sweep's result becomes order-dependent.
 *
 * `desktopApi` is currently the only such global (verified across all three glob
 * roots); the list is a list so a second one is a one-line addition rather than
 * a redesign.
 */
const STORY_INSTALLED_GLOBALS = ["desktopApi"];

// Relative to this file. Vite resolves `import.meta.glob` patterns at transform
// time, so these must stay literal — they cannot be read from `main.ts` at
// runtime, which is why the parity guard exists.
//
// Every extension Storybook indexes is listed, not just the .ts/.tsx that exist
// today: `main.ts` globs `*.stories.@(js|jsx|mjs|ts|tsx)`, and a sweep covering
// a narrower set would silently skip a future `.jsx` story. A pattern matching
// nothing is free.
const storyModules = import.meta.glob<StoryModule>([
  "../stories/**/*.stories.js",
  "../stories/**/*.stories.jsx",
  "../stories/**/*.stories.mjs",
  "../stories/**/*.stories.ts",
  "../stories/**/*.stories.tsx",
  "../../../packages/app/*/components/**/*.stories.js",
  "../../../packages/app/*/components/**/*.stories.jsx",
  "../../../packages/app/*/components/**/*.stories.mjs",
  "../../../packages/app/*/components/**/*.stories.ts",
  "../../../packages/app/*/components/**/*.stories.tsx",
  "../../../apps/desktop/src/renderer/components/**/*.stories.js",
  "../../../apps/desktop/src/renderer/components/**/*.stories.jsx",
  "../../../apps/desktop/src/renderer/components/**/*.stories.mjs",
  "../../../apps/desktop/src/renderer/components/**/*.stories.ts",
  "../../../apps/desktop/src/renderer/components/**/*.stories.tsx",
]);

const loaded = await Promise.all(
  Object.entries(storyModules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([storyPath, load]) => {
      // An import-time throw would otherwise abort collection for the whole
      // sweep, hiding which file was at fault behind a single collection error.
      try {
        return { storyPath, module: await load(), importError: null };
      } catch (error) {
        return { storyPath, module: null, importError: error };
      }
    })
);

describe("every indexed story mounts and plays", () => {
  it("indexes a story corpus at all", () => {
    // A glob that silently matches nothing would make every assertion below
    // vacuous and the suite would still report green.
    if (loaded.length === 0) {
      throw new Error(
        "story sweep matched zero files — the import.meta.glob patterns are wrong"
      );
    }
  });

  for (const { storyPath, module, importError } of loaded) {
    describe(storyPath, () => {
      if (importError !== null) {
        it("imports", () => {
          throw importError;
        });
        return;
      }

      const composed = composeStories(module as StoryModule);
      const names = Object.keys(composed);

      if (names.length === 0) {
        it("exports at least one story", () => {
          throw new Error(`${storyPath} exports no stories`);
        });
        return;
      }

      for (const name of names) {
        it(name, async () => {
          await runIsolated(composed[name]);
        });
      }
    });
  }

  // Declared after the per-story blocks so it runs last: proves the restore in
  // `runIsolated` actually fires, rather than trusting that it was wired up.
  it("leaves no story-installed global behind", () => {
    const leaked = STORY_INSTALLED_GLOBALS.filter((key) =>
      Object.hasOwn(globalThis.window, key)
    );
    expect(
      leaked,
      `${leaked.join(", ")} survived the sweep — a later story could read it instead of its own fixture`
    ).toEqual([]);
  });
});

/**
 * Runs one story, restoring the globals the corpus installs afterwards. Restores
 * the original property DESCRIPTOR (or removes the property when there was none)
 * rather than assigning `undefined`, per this repo's browser-global test rule —
 * assigning would leave a real own property behind that reads as "installed".
 */
async function runIsolated(story: ComposedStory): Promise<void> {
  const target = globalThis.window;
  const saved = STORY_INSTALLED_GLOBALS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(target, key)] as const
  );

  try {
    await story.run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    }
  }
}
