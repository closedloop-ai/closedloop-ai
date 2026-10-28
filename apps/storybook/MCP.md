# Connecting an agent to this Storybook

There are two ways in, and they are not interchangeable.

| | Local MCP | Hosted catalog |
|---|---|---|
| Where | your machine, dev server running | the deployed URL, always on |
| Who can reach it | you | anything that can fetch a URL, no login |
| What it gives | live tools, including running tests | one JSON file, read only |
| Setup | a minute | none |

Use the local server while you are building. Use the hosted catalog for anything
that is not sitting at your desk: CI, a hosted agent, a teammate's tooling.

## Path A: the local MCP server

This is the richer option. It only answers while a Storybook dev server is
running on your machine — added in PLN-2024 Phase A.2, which migrated this app
from the webpack5 `@storybook/nextjs` framework to `@storybook/nextjs-vite`
specifically because `@storybook/addon-mcp` needs `@storybook/addon-vitest`,
which refuses to run on webpack.

### 1. Start Storybook

```bash
pnpm install
pnpm -C apps/storybook dev
```

No design-system build step: `.storybook/main.ts`'s `viteFinal` aliases
`@repo/design-system` straight to its `.tsx` source (not `dist`), and that
alias applies to `dev` the same way it does to `build`.

Wait for the "Storybook ready" banner. **Check the port it prints.** It wants
6006, but if something else already has it, Storybook takes the next free one
without making a fuss, and then nothing below will connect.

### 2. Point your agent at it

**Claude Code.** Per-developer, not repo-shared — this repo tried a
committed root `.mcp.json` once (AI-355, Feb 27) and reverted it: a server
pointed at a localhost port only some developers run is not something
everyone's agent session should pick up by default. Create your own
`.mcp.json` at the repo root and keep it out of git (it's already ignored if
you name it `.mcp.local.json` and copy it in, or just leave it unstaged):

```json
{
  "mcpServers": {
    "storybook": { "type": "http", "url": "http://localhost:6006/mcp" }
  }
}
```

Open Claude Code in the repo and run `/mcp` to confirm it connected. If
Storybook took a different port, change the URL to match.

**Cursor, or anything else that speaks MCP over HTTP.** Add the same server. In
Cursor that is Settings, then MCP, then a new server of type HTTP pointing at
`http://localhost:6006/mcp`.

**Designers:** you do not need to understand any of this beyond the two
commands above. Start Storybook, open Claude Code in the repo, and ask it
something like "which stories render the Session Card". It will use the tools
below to answer instead of guessing.

### 3. Check it is working

Ask your agent to list the docs pages. If it comes back with component names,
you are connected. If it says the tool is unavailable, Storybook is not
running or is on a different port.

### What you get

`@storybook/addon-mcp` exposes a fixed toolset over MCP — `docs-list`,
`docs-show`, `docs-show-story`, `stories-find-by-component`,
`stories-preview`, `stories-changed`, `test-run`,
`get-storybook-story-instructions`, and `review-create` among them. Ask your
agent what tools it has connected rather than trusting a hand-typed list here
— the addon owns that surface, not this doc.

`test-run` runs stories in a real headless Chromium through the browser-mode
`storybookTest` project in `vitest.config.ts` (ISS-10397). It needs the
Playwright Chromium binary: if a run fails to launch a browser, run
`pnpm --filter storybook exec playwright install chromium` once. The same
project runs from the terminal with `pnpm --filter storybook test:storybook`.
Story files listed in `storybook-browser-exclusions.ts` fail in a real browser
for layout or CSS reasons the jsdom sweep never sees; `test-run` returns an
empty result for their stories until ISS-12836 clears them.

`pnpm --filter storybook test:mcp` boots `storybook dev`, connects to `/mcp`
and checks the tool list, `docs-list` / `docs-show`, and one real `test-run`.
The Storybook Browser Nightly workflow runs both commands once a night.

`stories-find-by-component` is the one that changes how work feels. Point it
at a component you are about to edit and it tells you what you are about to
affect, without grepping.

## Path B: the hosted catalog

`storybook build` produces static files. There is no server behind them, so
`/mcp` does not exist on the deployed URL and cannot. That is what a static
build is, not a configuration we have got wrong.

What IS on the deployed URL is the component manifest, a Storybook 10.6
built-in that carries most of what `docs-list` and `docs-show` would tell you:

```
https://prototypes.preview.stage.example/storybook/manifests/components.json
```

No login needed (docs/design/storybook-governance.md § Hosting: the
deployment is deliberately public). Roughly 2.5MB as of this writing.
`features.componentsManifest` (`.storybook/main.ts`) is what turns this file
on at all — it's a recent addition (ISS-10257), so this URL 404s until the
deployment behind it (which tracks a pipeline-blessed `main` SHA, not every
commit — same § Hosting) catches up past that change.

```bash
curl -s \
  https://prototypes.preview.stage.example/storybook/manifests/components.json
```

The story index sits next to it at `/index.json`, which maps every story id to
its title and file — useful for checking a title matches what
`validate:catalog` expects without a local checkout.

### What it cannot do

It is a file, not a service. No previews, no test running, no change
detection. If you need those, you need Path A.

## Which to use

Building components or stories, at your desk: **Path A.** You get previews and
test runs, and the instructions tool keeps an agent writing stories the way
this repo expects.

Anything automated, or anyone who cannot run a dev server: **Path B.** It is
one fetch, behind the same credentials as the rest of the hosted site.

## A note on the hosted URL

There is one hosted Storybook:
`https://prototypes.preview.stage.example/storybook`, the `/storybook`
path of the `apps/prototypes` deployment, which also serves the manifest
above. The standalone Storybook project is retired
(`docs/design/storybook-governance.md` § Hosting). The URL follows the
`green` branch, so it updates when `main`'s CI batch passes, not on every
merge. The manifest's titles are the ones in `TAXONOMY.md`.
