# Storybook

The component catalog for the design system, the shared App Core feature layer, and the Desktop renderer. Around 1,470 stories across 335 components.

```bash
pnpm turbo build --filter=@closedloop-ai/design-system   # first time, or after design-system changes
pnpm -C apps/storybook dev                               # http://localhost:6006
```

The hosted copy lives at https://storybook.preview.closedloop-stage.ai behind HTTP basic auth. See `DESIGNER-GUIDE.md` for the credential and the designer-facing tour.

## How it is organised

Four levels: Foundations, Primitives, Composites, Surfaces. Every story is titled
`<Level>/<Group>/<Component>`.

```
Foundations     5    the tokens themselves
Primitives    116    one cohesive element
Composites    197    built from primitives
Surfaces       16    a page, or a full page region
```

A component's title says what it is, never which package its code sits in. There is
no longer a `Design System` / `App Core` / `Desktop App` split: web and desktop are
held to parity, and anything that genuinely differs under the Electron shell gets a
variant that names the difference.

### The docs in this directory

| | |
|---|---|
| `BUILDING.md` | using these components to build a screen. Start here if you are writing UI. |
| `MCP.md` | connecting an agent, either the local MCP server or the hosted catalog. |
| `TAXONOMY.md` | the four levels, the group vocabulary, and how to classify something new. |
| `WRITING.md` | the one-sentence description at the top of each Docs page. |
| `AGENTS.md` | what a story file must carry. |
| `DESIGNER-GUIDE.md` | the designer-facing tour, and the preview credential. |

## What changed: this now runs on Vite

Storybook used to build with Webpack (`@storybook/nextjs`). It now builds with Vite (`@storybook/nextjs-vite`).

The trigger was `@storybook/addon-mcp`, which needs `@storybook/addon-vitest`, which refuses to run on a Webpack builder. But the migration was worth doing on its own:

| | Webpack | Vite |
|---|---|---|
| clean build | 47s | 43s |
| output size | 70M | 26M |
| dev server ready | minutes | 217ms manager, 264ms preview |

Dev startup is the one you will feel. It went from waiting for a full bundle to being usable before you have switched windows.

### Run `pnpm install`

Dependencies changed. `@storybook/nextjs` is gone, `@storybook/nextjs-vite` and the addons are in.

### `postcss.config.mjs` changed

This app used to register `tailwindcss` directly as a PostCSS plugin. Tailwind v4 rejects that form, and every other app in the repo already re-exports the design-system config. This one now does too. Webpack never exercised that code path, so the bug sat there unnoticed. `vitest.config.ts` had already called it out in a comment.

## Three things in `.storybook/main.ts` that are load-bearing

If Controls panels go empty or the build starts failing, it is almost certainly one of these. Please do not remove them without reading this.

**1. The docgen plugin is limited to TypeScript files.**

`react-docgen` (the JavaScript parser) calls a Babel 7 API that Babel 8 removed, and this repo runs Babel 8. Its latest release still requires Babel 7, so there is no version to upgrade to. Any `.js` file that reaches it crashes the build. Every component whose props matter here is TypeScript, so the plugin is constrained to `.ts` and `.tsx` and the problem disappears.

**2. Docgen gets explicit compiler options and include globs.**

The Vite docgen plugin builds a TypeScript program and silently skips any file outside it. This app's `tsconfig.json` only covers `apps/storybook`, so without this every component in `packages/**` gets no prop data. The build still passes. Nothing warns you.

That is exactly what happened on the first green Vite build: docgen fell from 644 components to 7 and the build reported success.

**3. `@repo/design-system` and `@repo/*` are aliased to source.**

The design-system package's `exports` map points at `dist`, which meant the builder was reading compiled JavaScript. Aliasing to source means docgen reads real `.tsx`. It also means the Storybook build no longer depends on `dist` being intact, which had been its own source of confusing failures.

## Checking that Controls did not regress

Prop data can vanish without any error, so treat it as something to measure rather than assume. There is a snapshot approach that was used to gate this migration:

1. Build Storybook.
2. Extract every `__docgenInfo` block from `storybook-static/assets/*.js` and record each component and prop.
3. Make your change, rebuild, extract again, diff.

The number that matters is not component count, it is **option values lost**. Reordering a union is cosmetic. Losing `"warning"` from a badge variant is not. The migration was accepted at 644 to 610 components with zero option values lost.

## Docs pages

Every story carries `tags: ["autodocs"]`, which generates a Docs page per component
with the description, a rendered example and the props table.

That tag was inert until recently. Storybook 9 dissolved `addon-essentials`, which
used to carry docs, into separate packages, and `@storybook/addon-docs` was never
re-added here. 1,405 entries were tagged `autodocs` and the built index contained
zero docs entries, so the prop tables this Storybook's Controls work produces had
nowhere to render. The addon is installed now and the build emits 320 docs pages.

Sixteen story files still have no `autodocs` tag, so they get no Docs page. Five are
the Foundations pages, which document tokens and have no props to table. The other
eleven look like oversights rather than decisions.

## MCP

With the dev server running, an MCP endpoint is served at `/mcp`. `.mcp.json` at the repo root points a client at it.

Eight tools are exposed, including `docs-list`, `docs-show`, and `stories-find-by-component`, which maps a component source file to the stories that render it. The point is that an agent asks the Storybook instead of grepping the codebase.

**This is dev only.** `storybook build` produces static files with no server behind them, so `/mcp` does not exist on the hosted URL and cannot. It works for whoever is running Storybook locally.

If port 6006 is busy, Storybook silently picks another one. Check the "Storybook ready" banner for the real port, and update `.mcp.json` to match, or free 6006 first.

## Tests

```bash
pnpm -C apps/storybook test
```

1,520 tests, about 25 seconds. The bulk is a sweep that mounts and plays every indexed story, so a story that throws on mount fails the suite.

These run on pull requests via the `storybook-build` job. That is recent: for a long time no Storybook test ran in CI at all.

## Titles are validated

```bash
pnpm -C apps/storybook validate:catalog
```

Story titles feed the component catalog, so they are checked. If you add or rename a story and this fails, run `pnpm -C apps/storybook catalog:sync` and commit the regenerated `packages/design-system/storybook/component-catalog.ts`.

Every story, colocated or not, must be titled `<Level>/<Group>/<Component>` where the
level is one of the four above. The catalog parses `section` and `pathSegments` straight
out of `meta.title`, so a title that does not start with a level cannot be catalogued at
all, and `validate:catalog` fails rather than letting it disappear.
