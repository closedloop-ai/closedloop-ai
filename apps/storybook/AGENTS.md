# Storybook (`apps/storybook`)

The Storybook host for the whole repo. Stories are NOT co-located with most components — they are collected by a fixed set of globs, so where a story file lives decides whether it exists at all.

## Where a story is collected from

**Storybook scans exactly four globs** (the `stories` array in `apps/storybook/.storybook/main.ts`, repo-relative): `apps/storybook/stories/**/*.mdx`, `apps/storybook/stories/**/*.stories.@(js|jsx|mjs|ts|tsx)`, `packages/app/*/components/**/*.stories.@(ts|tsx)`, `apps/desktop/src/renderer/components/**/*.stories.@(ts|tsx)`. Only `*.mdx` and `*.stories.*` files match — a plain `.tsx` under `apps/storybook/stories/` is not a story — and a story co-located anywhere else (`apps/app/**`, `packages/app/*/lib/`, `packages/design-system/**`, `apps/prototypes/**`) is silently never picked up. A prop-driven component with a state matrix owes an isolated story at the moment it is **promoted** to an exported module; if it cannot get one where it lives, that is the signal it belongs in a scanned directory.

Consequences worth stating once:

- `packages/design-system` is not a scan glob. A story for a design-system component goes under `apps/storybook/stories/`.
- `packages/app/*/lib/` is not a scan glob — only `packages/app/*/components/**`.

## What a story must carry

- **A title** of the form `<Level>/<Group>/<Component>`, where Level is `Foundations`, `Primitives`, `Composites` or `Surfaces`. `TAXONOMY.md` has the group vocabulary and how to classify something new. `validate:catalog` fails the build on a title outside it, or on two files claiming the same title.
- **`tags: ["autodocs"]`**, which is what generates the Docs page.
- **A description**: a comment directly above `const meta`. It becomes the paragraph at the top of the Docs page AND the text the component manifest hands to an agent asking what the component is. `WRITING.md` is the standard. Plain English, written for designers and product people as much as for engineers, not a ticket summary.
- **A first story that shows the component working.** Storybook orders stories by export order and lands on the first one, so a file that opens on `Loading` or `Error` shows a broken state as the component's face. Put the representative story first and name it `Default` unless there is a reason not to.
