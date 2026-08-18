# Storybook (`apps/storybook`)

The Storybook host for the whole repo. Stories are NOT co-located with most components — they are collected by a fixed set of globs, so where a story file lives decides whether it exists at all.

## Where a story is collected from

**Storybook scans exactly four globs** (the `stories` array in `apps/storybook/.storybook/main.ts`, repo-relative): `apps/storybook/stories/**/*.mdx`, `apps/storybook/stories/**/*.stories.@(js|jsx|mjs|ts|tsx)`, `packages/app/*/components/**/*.stories.@(ts|tsx)`, `apps/desktop/src/renderer/components/**/*.stories.@(ts|tsx)`. Only `*.mdx` and `*.stories.*` files match — a plain `.tsx` under `apps/storybook/stories/` is not a story — and a story co-located anywhere else (`apps/app/**`, `packages/app/*/lib/`, `packages/design-system/**`, `apps/prototypes/**`) is silently never picked up. A prop-driven component with a state matrix owes an isolated story at the moment it is **promoted** to an exported module; if it cannot get one where it lives, that is the signal it belongs in a scanned directory.

Consequences worth stating once:

- `packages/design-system` is not a scan glob. A story for a design-system component goes under `apps/storybook/stories/`.
- `packages/app/*/lib/` is not a scan glob — only `packages/app/*/components/**`.
