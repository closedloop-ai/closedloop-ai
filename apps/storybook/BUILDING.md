# Building a screen with this design system

For anyone, human or agent, writing ClosedLoop UI. The other docs here are about
the Storybook itself: `TAXONOMY.md` is how components are filed, `WRITING.md` is
how they are described, `MCP.md` is how to connect an agent. This one is about
using the components to build something.

## Find the component before you write one

Almost everything you need exists. 335 components, and the catalog is searchable
two ways:

- Open the Storybook and read the sidebar. Four levels, smallest to largest:
  Foundations, Primitives, Composites, Surfaces.
- Or ask an agent connected over MCP (`MCP.md`). `docs-list` gives you every
  component with a one-line description of what it is and when to pick it.

Those one-liners exist specifically to answer "there are three things that look
like this, why would I pick this one". Read them before building a lookalike.

## The rules that actually get broken

Each of these is here because it went wrong in the product, not because it
sounded good.

### Never set a colour with `className` on a component that has a variant

```tsx
<Badge className="bg-green-100 text-green-800">Merged</Badge>   // no
<ToneBadge tone="success" label="Merged" />                     // yes
```

`className` wins over the variant classes, so the component stops looking like
itself. This is exactly how the dashboard status badges drifted away from the
rest of the product: each call site painted its own green.

A test enforces it for screens:
`apps/storybook/__tests__/surfaces-respect-design-system.test.ts`.

### Pick a status colour by what the state MEANS

`ToneBadge` takes a `tone`, not a colour. Choose `success`, `warning`, `danger`
or `info` by the meaning, and the system decides how that looks. It stays
consistent everywhere, and it can be restyled once rather than in forty places.

It also renders a small dot beside the fill. That is not decoration: it is what
makes the state readable to someone who cannot resolve the colour. Do not turn
`showDot` off on a pill that carries a state.

### Chart series: call `chartSeriesColor(i)`, do not pick `--chart-N` by index

The natural order `--chart-1` through `--chart-10` seats colour-vision-confusable
hues next to each other and opens on the token that is nearly invisible on the
light surface. Measured, it fails at ΔE 5.4 with 1.31:1 contrast in the first
slot. `chartSeriesColor(i)` uses an order that passes at ΔE 18.0 and 3.89:1.

It caps at 10 series and never wraps. Past that, fold the rest into a neutral
"Other" band rather than reusing a colour. And colour alone separates only about
one series across all pairs, so a dense chart needs a second encoding too.

`Foundations/Colors` shows the palette and the real series order.

### A form control beside a label needs `items-center`

```tsx
<div className="flex gap-2">                 // no, the box sits off centre
<div className="flex items-center gap-2">    // yes
```

A bare `flex` row is `align-items: stretch`, so a 16px checkbox and a
`leading-none` label both start at the top and the text lands a pixel above the
box. Eleven of the thirteen places the product does this use `items-center`. One
uses `items-start` deliberately, for labels that wrap to several lines.

### Links inside a sentence use `linkForeground`

`variant="link"` paints the link colour. For a link that reads as part of the
surrounding sentence rather than as a separate call to action, use
`variant="linkForeground"`, which keeps the text colour and just underlines.

Twelve of the eighteen `variant="link"` uses in this repo were repainting it by
hand before this variant existed.

## Composing a page

Build up the levels. A Surface is composites, a composite is primitives.

**Do not hand-build a lookalike of something that exists.** A screen assembled
from hand-written markup drifts from the product with nothing failing, because
no test compares your version to the real one. A screen assembled from the
shipped components cannot drift: a change to a component lands in it on the next
render.

`Surfaces/Sessions` is the worked example. It mounts the real `SessionsToolbar`,
`SessionsSummaryCards`, `SyncedSessionsTable` and `SessionsEmptyState` in the
same arrangement as the production page, and re-implements none of them.

When you mount a real component, check which wrapper production uses. The
Sessions page does not mount the presentational `SessionsTable` directly: it goes
through a thin shell over `SyncedSessionsTable`, and that shell is what supplies
the row-state chips and the linked-entity columns.

## Every state, not just the happy one

A surface usually has more states than you first think. The sessions list has
five: rows, still loading, filtered down to nothing, no agent connected yet, and
could not load.

Give each one its own message. A single generic empty state that says "no
sessions found" when the read actually failed tells someone to stop looking for
something that is fine.

The two that matter most are the pair that make opposite claims: "not found"
means the record is gone, "unavailable" means it exists and the read failed.
Getting those the wrong way round sends someone off to look for a session that is
sitting there.

## Before you call it done

```bash
pnpm -C apps/storybook test              # mounts and plays every story
pnpm -C apps/storybook validate:catalog  # story titles and the catalog
pnpm exec biome check --write <files>
```

If you added or changed a story, `AGENTS.md` in this directory lists what it has
to carry: a title in the taxonomy, `autodocs`, a one-sentence description, and a
first story that shows the thing working rather than a skeleton.

Six guards run in CI and will tell you plainly what you broke. They exist because
each of them caught something real once.
