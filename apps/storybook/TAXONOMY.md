# How this Storybook is organised

Four levels, smallest to largest. The point of the split is that you can tell what
a thing *is* from where it sits, rather than from which package its code happens
to live in.

```
Foundations   the tokens themselves: colour, type, spacing, radius, motion, chart palette
Primitives    one cohesive element
Composites    built from primitives
Surfaces      a page, or a full page region, built from composites
```

Every story title is `<Level>/<Group>/<Component>`. Foundations is flat, and
Surfaces is flat. `validate:catalog` fails the build if a title does not start
with one of the four levels.

## Where the code lives does not matter

This is the rule the whole structure hangs on.

A component's title is decided by what it is, never by whether it sits in
`packages/design-system`, `packages/app` or `apps/desktop`. The old structure
had `Design System`, `App Core` and `Desktop App` as top-level sections, which
meant the same kind of thing appeared in three places and moving a file between
packages silently renamed its story.

Desktop and web are held to parity. If something genuinely differs under the
Electron shell, it gets a variant that names the difference, not a separate
section. There is exactly one today:

```
Surfaces/Session Detail                    the shared surface, 22 stories
Surfaces/Session Detail (Desktop Shell)    3 stories for the Electron boundaries
```

## The four levels

**Foundation.** Documents tokens, not components. Six of them. Five read their
values out of the DOM at runtime so they cannot drift from `globals.css`; the
sixth, Chart Colors, renders live `var(--chart-N)` swatches for the same reason.

**Primitive.** Renders as one element. Wrapping a third-party control still
counts: `Select` wraps Radix, `Calendar` wraps react-day-picker, and both are
still one control.

**Composite.** Built from primitives. If you can point at the parts, it is a
composite.

**Surface.** Composes composites into a page or a full region of one. Usually has
a shell, a header, and more than one panel.

## The groups

Two vocabularies. Both are closed: adding a group is a deliberate edit here and
in `.storybook/preview.tsx`, not something that happens by writing a title.

### Element kinds

Used by every Primitive, and by any Composite that is not bound to a feature.
Ordered by what you do with the thing rather than alphabetically, and that order
is the sidebar order.

| Group | What belongs |
|---|---|
| Actions | things you click to do something |
| Inputs | things you type or choose into |
| Data Display | presents values as-is |
| Charts | plots data geometrically |
| Content | renders authored or streamed text and code |
| Layout | arranges other things without knowing what they are |
| Navigation | moves you between places |
| Overlays | renders on a layer above the page |
| Feedback & Status | communicates system state |

### Domains

Composites only, for anything bound to a product feature.

```
Agents  Sessions  Branches  Documents  Packs  Compute
Insights  My Tasks  Settings  Onboarding  Tags  App Shell
```

## How to classify something new

1. Does it document tokens? Foundation.
2. Does it render as one element? Primitive. Even if it imports `Button`, even if
   it wraps a third-party control. Give it an element kind.
3. Does it compose composites into a page or page region? Surface.
4. Otherwise Composite. Give it a domain if it is bound to a feature, an element
   kind if it is not.

Two tie-breakers that come up constantly:

- A badge or icon whose job is to report state (loading, synced, healthy, failed)
  is **Feedback & Status**, not Data Display.
- Anything that is a tooltip is **Overlays**, whatever it contains.

## The judgment calls, and why

These are places where the obvious mechanical rule gives the wrong answer. They
are written down rather than left to whoever touches this next.

### A single dependency does not make you a composite

72 components import exactly one other component, and it is usually `Button`.
`Copy Button` imports button. `Alert Dialog` imports button. `Calendar` imports
button.

Calling all 72 composites would shrink Primitives to about 41 and make the level
meaningless. `Copy Button` is a button with a copy behaviour attached, not a
composition of parts.

**The line: one dependency is still a primitive if the thing renders as one
element.** `Copy Button` stays primitive. `Kanban Board` imports one component
and is plainly a composite, because it renders a board.

### The import graph measures reuse, not complexity

29 components import nothing from the design system and are over 200 lines. Two
are extreme: `Session Detail` is 1,588 lines and `Session Activity Breakdown` is
1,188. By imports alone they are primitives, which is obviously wrong. They are
not built from our parts because they build everything inline instead.

This is the trap in the whole exercise. A 1,588 line component that reuses
nothing looks exactly like a 40 line button.

### Surfaces is a reviewed list, not a line count

An earlier version of this document said "over roughly 300 lines it is not a
primitive, whatever it imports" and used that to promote things to Surfaces.

That rule is gone, because it is the same mistake as the one above with a
different proxy. Line count correlates with being a page; it does not mean being
a page. It promotes a long, fiddly single control and misses a short one that
composes four panels.

Surfaces is now an explicit list of 16, reviewed one at a time:

```
Login                       Dashboard                  Settings
Sessions                    Session Detail             Session Detail (Desktop Shell)
Session Activity Breakdown  Session Transcript Panel   Agent Detail
Branch Detail Page          Pack Detail                Packs Workspace
Comments Workspace          Data Sync Tab              Withheld Tab
Telemetry Analytics
```

Adding one is a deliberate edit to that list. That is the point: a level that
anything can fall into by accident is not a level.

### One domain was too big for the sidebar

Sessions came out at 46 composites, which is a wall in a left nav. It splits by
the surface each part serves:

```
Composites/Sessions/Listing   20    the list page and its parts
Composites/Sessions/Detail    14    the session detail pane
Composites/Sessions/Trace     12    the trace and transcript
```

**The line: a domain over about 25 stories splits into named sub-families.**
Sessions is the only one that qualifies. Branches (21) and Documents (18) stay
flat.

## Surfaces compose the real components

`Surfaces/Sessions` mounts `SessionsToolbar`, `SessionsSummaryCards`,
`SessionsTable` and `SessionsEmptyState`: the same components
`apps/app/(authenticated)/[orgSlug]/sessions/page.tsx` mounts, in the same
arrangement. Nothing in it re-implements a part.

That is what the level is for. A surface built out of hand-written lookalikes can
drift from the product without anything failing. A surface built out of the
shipped composites cannot, because a change to a composite lands in it on the
next render.

The older surfaces (Dashboard in particular) still use fixtures for some regions.
Those are worth converting as they are touched, not in one pass.

## The catalog reads titles, it does not invent them

`packages/design-system/storybook/component-catalog.ts` is generated by
`catalog:sync`. Its `section` and `pathSegments` are parsed from each story's own
`meta.title`.

It used to synthesize titles from a category map maintained alongside the story
files, which is two sources of truth for one fact. They drifted: after the
retitle, all 113 design-system entries disagreed with the stories they pointed
at. The category map is gone. Four surfaces have no story at all and are titled
explicitly in `catalogOnlyTitlesById`.

## Reproducing the measurement

The level split is derived rather than decided by taste, and it can be re-run:

For every story file, resolve the component it renders (sibling `.tsx` for
colocated stories, `packages/design-system/components/ui/` for design-system
ones). Count that component's imports matching
`@repo/design-system/components/ui/*` or
`@closedloop-ai/design-system/components/ui/*`, excluding itself.

Zero imports is a primitive. One or more is a composite unless it renders as a
single element. Surfaces is the reviewed list above, not a derived result.

Today that gives 116 primitives, 197 composites, 16 surfaces and 6 foundations
across 335 story files.

## A note on renaming cost

Story ids come from titles, so every retitle resets that story's Chromatic
baseline. Nothing changes visually, but each one needs approving once. Worth
batching taxonomy changes rather than trickling them.
