# Connecting an agent to this Storybook

There are two ways in, and they are not interchangeable.

| | Local MCP | Hosted catalog |
|---|---|---|
| Where | your machine, dev server running | the deployed URL, always on |
| Who can reach it | you | anything that can fetch a URL |
| What it gives | 9 tools, live, including running tests | one JSON file, read only |
| Setup | a minute | none |

Use the local server while you are building. Use the hosted catalog for anything
that is not sitting at your desk: CI, a hosted agent, a teammate's tooling.

## Path A: the local MCP server

This is the richer option. It only answers while a Storybook dev server is
running on your machine.

### 1. Start Storybook

```bash
pnpm install
pnpm turbo build --filter=@closedloop-ai/design-system   # first time only
pnpm -C apps/storybook dev
```

Wait for the "Storybook ready" banner. **Check the port it prints.** It wants
6006, but if something else already has it, Storybook takes the next free one
without making a fuss, and then nothing below will connect.

### 2. Point your agent at it

**Claude Code.** Already configured. `.mcp.json` at the repo root is checked in:

```json
{
  "mcpServers": {
    "storybook": { "type": "http", "url": "http://localhost:6006/mcp" }
  }
}
```

Open Claude Code in the repo and run `/mcp` to confirm it connected. If Storybook
took a different port, change the URL to match.

**Cursor, or anything else that speaks MCP over HTTP.** Add the same server. In
Cursor that is Settings, then MCP, then a new server of type HTTP pointing at
`http://localhost:6006/mcp`.

**Designers:** you do not need to understand any of this beyond the two commands
above. Start Storybook, open Claude Code in the repo, and ask it something like
"which stories render the Session Card". It will use the tools below to answer
instead of guessing.

### 3. Check it is working

Ask your agent to list the docs pages. If it comes back with component names, you
are connected. If it says the tool is unavailable, Storybook is not running or is
on a different port.

### What you get

| Tool | What it answers |
|---|---|
| `docs-list` | what components exist |
| `docs-show` | everything about one component, including its props |
| `docs-show-story` | the source of one story |
| `stories-find-by-component` | given a component file, which stories render it |
| `stories-preview` | a rendered preview of a story |
| `stories-changed` | which stories your working changes affect |
| `test-run` | run the story tests, including accessibility checks |
| `get-storybook-story-instructions` | Storybook's own rules for writing stories |
| `review-create` | open a review of story changes |

`stories-find-by-component` is the one that changes how work feels. Point it at a
component you are about to edit and it tells you what you are about to affect,
without grepping.

## Path B: the hosted catalog

`storybook build` produces static files. There is no server behind them, so
`/mcp` does not exist on the deployed URL and cannot. That is what a static build
is, not a configuration we have got wrong.

What IS on the deployed URL is the component manifest, which carries most of what
`docs-list` and `docs-show` would tell you:

```
https://storybook.preview.closedloop-stage.ai/manifests/components.json
```

It is behind the same HTTP basic auth as the rest of the site (`closedloop`, and
the password is in `DESIGNER-GUIDE.md`). Roughly 2.8MB.

```bash
curl -s -u closedloop:<password> \
  https://storybook.preview.closedloop-stage.ai/manifests/components.json
```

### What is in it

335 components. Per component:

```jsonc
{
  "id": "primitives-actions-button",
  "name": "Button",
  "path": "./stories/button.stories.tsx",
  "description": "A clickable control for triggering a one-time action, ...",
  "stories": [ /* every story, by name */ ],
  "reactDocgenTypescript": {
    "props": {
      "variant": { "type": { "name": "\"default\" | \"destructive\" | ..." } }
    }
  }
}
```

312 of the 335 carry a description, and 293 carry full prop data, 1,647 props in
total. The rest are components defined inside their own story file, so there is
nothing to read props from.

Those figures move whenever a component is added or wired up, so treat them as a
sense of scale rather than a contract. `manifests/components.json` is the source
of truth; count it if you need the number.

The story index sits next to it at `/index.json`, which maps every story id to
its title and file.

### What it cannot do

It is a file, not a service. No previews, no test running, no change detection.
If you need those, you need Path A.

## Which to use

Building components or stories, at your desk: **Path A.** You get previews and
test runs, and the instructions tool keeps an agent writing stories the way this
repo expects.

Anything automated, or anyone who cannot run a dev server: **Path B.** It is one
fetch and it is always current, because it is rebuilt and redeployed with the
Storybook.
