# How this Storybook is organised

Four levels, from smallest to largest. The point of the split is that you can tell what a thing *is* from where it sits, rather than from which folder its code happens to live in.

```
Foundations   the tokens themselves: colour, type, spacing, radius, motion
Primitives    one cohesive element
Composites    built from primitives
Surfaces      a page, or a full page region, built from composites
```

## The rules

**Foundation.** Documents tokens, not components. There are five and they read their values out of the DOM at runtime so they cannot drift from `globals.css`.

**Primitive.** Renders as one element. Wrapping a third party control still counts: `Select` wraps Radix, `Calendar` wraps react-day-picker, and both are still one control.

**Composite.** Built from primitives. If you can point at the parts, it is a composite.

**Surface.** Composes composites into a page or a full region of one. Usually has a shell, a header, and more than one panel.

## The three judgment calls, and why

These came out of classifying all 335 stories. Each one is a place where the obvious mechanical rule gives the wrong answer, so they are written down rather than left to whoever touches this next.

### A single dependency does not make you a composite

72 components import exactly one other component, and it is usually `Button`. `Copy Button` imports button. `Alert Dialog` imports button. `Calendar` imports button.

Calling all 72 composites would shrink Primitives to about 41 and make the level meaningless. `Copy Button` is a button with a copy behaviour attached, not a composition of parts.

**The line: one dependency is still a primitive if the thing renders as one element.** `Copy Button` stays primitive. `Kanban Board` imports one component and is plainly a composite, because it renders a board.

### Line count overrides the import graph

29 components import nothing from the design system and are over 200 lines. Two are extreme: `Session Detail` is 1,588 lines and `Session Activity Breakdown` is 1,188.

By imports alone they are primitives, which is obviously wrong. They are not built from our parts because they build everything inline instead.

Worth stating plainly, because it is the trap in this whole exercise: **the import graph measures reuse, not complexity.** A 1,588 line component that reuses nothing looks exactly like a 40 line button.

**The line: over roughly 300 lines it is not a primitive, whatever it imports.** Those two are surfaces.

### Surfaces already exist, they are just not called that

`Agent Detail`, `Pack Detail`, `Packs Workspace` and `Branch Detail Page` are page level compositions sitting in feature folders. Eleven components match that shape.

They get promoted to Surfaces. Leaving them where they are repeats the original problem, which is organising by where code lives rather than by what a thing is.

## How to classify something new

1. Does it document tokens? Foundation.
2. Does it render as one element? Primitive, even if it imports `Button`, even if it wraps a third party control.
3. Is it over 300 lines, or does it compose several composites into a page or page region? Surface.
4. Otherwise, Composite.

If steps 2 and 3 disagree, 3 wins.

## Reproducing the measurement

The classification is derived rather than decided by taste, and it can be re-run:

For every story file, resolve the component it renders (sibling `.tsx` for colocated stories, `packages/design-system/components/ui/` for design system ones). Count that component's imports matching `@repo/design-system/components/ui/*` or `@closedloop-ai/design-system/components/ui/*`, excluding itself. Record the line count.

Zero imports and under 300 lines is a primitive. One or more imports is a composite unless it renders as a single element. Over 300 lines, or composing composites into a page, is a surface.

At the time of writing that gives 113 primitives, 194 composites, and 28 story local wrappers that need deciding one at a time.

## The 28 wrappers

Some stories point `component:` at a wrapper defined inside the story file rather than at a real component. Those have no props to classify and no prop surface for controls to bind to. They are handled case by case, not batched, and several are deliberate: four Desktop stories each install a competing `window.desktopApi` fixture and genuinely cannot share a docs page.

## A note on renaming cost

Story ids come from titles, so every retitle resets that story's Chromatic baseline. Nothing changes visually, but each one needs approving once. Worth batching taxonomy changes rather than trickling them.
