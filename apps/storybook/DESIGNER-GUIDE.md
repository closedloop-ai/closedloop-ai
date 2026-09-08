# Storybook for designers

A plain-language guide to using this Storybook with Claude. You do not need to
know how to code to use any of this.

## What Storybook is

Storybook is a living catalog of every piece of the product's interface. Buttons,
cards, tables, charts, whole page sections. Each piece is shown on its own so you
can look at it closely, poke at it, and see how it behaves.

Think of it as the design file, except it is showing you the real thing the
engineers ship, not a picture of it. If it looks a certain way here, that is how
it actually looks in the product.

## Just want to look at it?

Open this. Nothing to install.

**https://storybook.preview.closedloop-stage.ai**

It asks for a username and password:

- Username: `closedloop`
- Password: `kickback-preview-2026`

That covers everything below except making changes. If you only need to review
components, stop here.

## Getting set up to make changes

Only needed if you are going to edit something. This work lives on its own
branch, not on `main`. Everything below is copy-paste; you only do the first
block once.

Get the code:

```
git clone https://github.com/closedloop-ai/closedloop-ai.git
cd closedloop-ai
git checkout storybook/foundations-catalog-controls
pnpm install
```

Start it up:

```
pnpm -C apps/storybook dev
```

Then open the address it prints, usually `http://localhost:6007`.

Every time you come back to it, run these two:

```
git pull
pnpm -C apps/storybook dev
```

If you are already working in the repo and just need to switch onto this
branch:

```
git fetch origin
git checkout storybook/foundations-catalog-controls
```

Stay on that branch while you work. If you are ever unsure which one you are
on, `git branch --show-current` prints it.

## How it is organized

The left sidebar goes from smallest to largest, top to bottom.

1. **Catalog** — a searchable index of every component with a live preview of
   each one. Start here when you do not know what something is called. Click any
   card to jump to it.
2. **Foundations** — the raw ingredients. Colors, type sizes, spacing, corner
   rounding. These are the decisions everything else is built from.
3. **Design System** — the basic building blocks. Buttons, inputs, badges,
   cards.
4. **App Core** — bigger pieces built from those blocks, grouped by product
   area. Branches, Sessions, Agents, Insights.
5. **Desktop** — pieces that only appear in the desktop app.
6. **Screens** — whole assembled pages. Login, Dashboard, Settings. This is
   where you go to see how the parts add up, rather than judging a button on
   its own.

## The three things worth knowing

**Switch light and dark.** There is a control in the toolbar at the top. Every
component should look right in both. If one does not, that is a real bug worth
reporting.

**Change the settings yourself.** Under most components there is a Controls
panel. It lists that component's options: the text it shows, whether it is
disabled, which size it is. Change any of them and the component updates as you
watch. Nothing you do here can break anything, and refreshing the page puts it
all back.

**Every state is already built.** Components usually have several versions
listed under them in the sidebar. Loading. Empty. Error. Too much text. These
are the situations designers usually forget, and they are already here for you
to look at.

## Working with Claude on this

You can ask Claude to make changes to what you see. The trick is being specific
about which component you mean.

Copy the name from the sidebar. If you are looking at "App Core / Branches /
Branches Summary Cards", say exactly that. Claude can find it instantly from
that name.

Things that work well:

- "In App Core / Branches / Branches Summary Cards, the explanation text under
  the number is too long and competes with the number. Move it into the little
  info icon instead."
- "Show me every component that uses the warning color."
- "The empty state for Documents feels cold. Give me three warmer versions of
  the wording."
- "Add a story showing what Sessions looks like when someone has a hundred of
  them."
- "Does this component work on a narrow screen? Show me."

Things to avoid:

- "Fix the card." There are dozens of cards. Name the one.
- "Make it look better." Say what is wrong. Too cramped, too loud, hard to read.

## A good habit

When something looks off, screenshot it and paste it to Claude along with the
component name from the sidebar. A picture plus a name is usually all it needs.

## If something looks broken

Some components need data to render. If you land on one and it is blank or shows
an error, that is usually a missing setup detail, not a design problem. Say which
story it was and it can be fixed.
