# How this Storybook is organised

This is the one guide to how the Storybook is laid out and why. Designers,
engineers and agents all read it. **"The short version" is all you need to
place, name and write a story. "For designers" covers looking at the
Storybook, changing it, and working with Claude on it.** The rest of the file is the detail and the
history behind it. If this file and the code disagree, the code is right: fix
this file in the same change.

## The short version

### The sidebar, top to bottom

```
Start Here         Introduction, Catalog, Version History. About the system, not part of it.
                   Catalog is a searchable index of every component, for when you do
                   not know what something is called.

Foundations        ┐
Primitives         │
Composites         │  the current Storybook: where new work goes, organised by page.
Patterns           │  Each entry is Stable, Preview or Experimental.
Surfaces           ┘

Foundations v1.0   ┐
Primitives v1.0    │  v1.0: the old baseline, Deprecated. Kept as it was until removed.
Composites v1.0    │
Surfaces v1.0      ┘
```

**Why:** the current roots are what is being designed and built now, so they
come first, under the plain level names. v1.0 stays below, untouched and
marked Deprecated, so the current Storybook can change freely without breaking
what the app already relies on, and you can compare the two until v1.0 is
removed.

### Five levels, smallest to largest

| Level | What it is | Why it is its own level |
|---|---|---|
| **Foundations** | Tokens: colour, type, spacing, radius, motion | Everything else is drawn from them. Change a token and every level changes with it. |
| **Primitives** | One element: a button, an input, a badge. Still a primitive if it wraps a third-party control or uses one other component | The vocabulary every page uses. You find one by what it does, not by which page it is on. |
| **Composites** | Built from primitives: a **section of a page**: a panel, a tab body, a toolbar, a rail | The parts an engineer lifts into a page. |
| **Patterns** (no v1.0 root) | A page's **shell and layout, with no content**: every slot is an empty, named region | You can review layout and how it responds to width without content in the way, and see which slot each section fills. |
| **Surfaces** | A **finished page**: the live app's own page, fed with fixture data | It shows the real page, so it cannot drift from the app. |

A component's level comes from **what it is, never from where its code
lives** (`packages/design-system`, `packages/app` or `apps/desktop`).
**Why:** the old sidebar was sorted by package, which told you where a file
was and nothing about what it was.

### The Storybook is organised by page

**Surfaces sets the tree of pages**, in the same order as the live app's
sidebar, so you find a page in Storybook where you find it in the app:
Dashboard, then `Artifacts` (Sessions, Branches), `Labs`, `Your Teams`. Pages
the sidebar does not show come after it: `Workspace Menu`, `Other Pages`,
`Not In The Live App`, `Desktop Only`, `Sign In`, `Onboarding`,
`System States`. The folders only group pages, so they have no story of their
own.

**Composites and Patterns use the same tree.** The same name means
the same page in every root:

```
Patterns/Artifacts/Sessions/Session Detail                the layout
Composites/Artifacts/Sessions/Session Detail/Page Header  one section (one entry per section)
Surfaces/Artifacts/Sessions/Session Detail                the finished page
```

- A section used by one page sits under that page. A section several pages
  share sits under the deepest page they all share, or under
  `Shared/<kind of page>` when they are in different parts of the tree
  (`Composites/Shared/Artifact Detail/Collaborators`).
- Primitives and Foundations are not placed by page. Every page uses them.
- Each of Composites, Patterns and Surfaces opens with an
  **Overview** page: what belongs there, what does not, how the three link.

**Why:** when someone picks up a page to build, everything for it is at one
path, in three roots.

### Lifecycle (ISS-12610)

- **Every story file carries exactly one lifecycle tag in its own meta**,
  from Storybook's feature lifecycle
  (https://storybook.js.org/docs/releases/features). The sidebar shows it as
  a badge, and its tag filter can show one stage at a time.
  `validate:catalog` fails a file with none, or more than one.

  | Tag | Meaning | Where |
  |---|---|---|
  | `stable` | Done, and matches the live app | The current roots, except as below; Start Here |
  | `preview` | Built and nearly final, still being reviewed or adjusted | Everything under `Labs` |
  | `experimental` | Design-only or exploratory, with no live counterpart yet | Everything under `Not In The Live App`; design-preview stories of a page the app has not shipped (Branch and Session Detail's design stories); anything marked not for build (`Composites/Shared/Activity/Future`) |
  | `deprecated` | The v1.0 baseline: frozen, no new work, removed in a later major release | Everything under a `… v1.0` root, and only there |

- **The tag goes in the file's own meta** (`tags: ["stable"]`), never in a
  spread: the static indexer drops spread tags. A story that differs from
  its file overrides it: `tags: ["!stable", "experimental"]`.
- **Deprecated and the v1.0 roots go together.** A story tagged `deprecated`
  is titled under `<Level> v1.0/`; every other story under the plain
  `<Level>/`. `validate:catalog` checks both directions.
- **Promotion:** Experimental → Preview → Stable as the work lands. A
  promotion is a release (below) and its Version History entry names the
  entries that moved ("Session Detail: Preview → Stable"). When a design
  replaces another, the new one takes the old one's place in the tree
  (2.0.24 did this for the Details tab).
- **The Storybook has a release number**: `version` in
  `apps/storybook/package.json`, recorded in `Start Here/Version History`,
  newest first. 3.0.0 introduced the lifecycle; before it, 2.0.x releases
  were changes inside "v2.0", the roots that are now the plain ones. Semver:
  a patch for a fix, a minor for new entries or promotions, a major for
  removals or story URL changes. A test fails when the page and the package
  disagree.
- **Adding, renaming, moving, promoting or removing stories is a release:**
  bump the version and add a Version History entry in the same change. This
  is a convention; CI does not check that a story change came with a bump.
  What is tested is that Version History's newest entry matches `version` in
  `package.json` (the page's play function, run by the story sweep).

**Why:** a stage on every story tells a reader whether to build from it, and
the release history tells a reviewer what changed and when, including links
that stopped working because a story was renamed.

### Inside one entry: the template

1. **Default first**, fully populated with realistic data. **Why:** it is what
   a reviewer judges and what an agent copies when it builds the page.
2. **Then its states**, in this order where they apply (for new or touched
   stories; existing pages such as Sessions List predate it, and nothing
   checks it): Loading · Syncing ·
   Empty · No Matches · Error · Not Found · No Permission · Unavailable ·
   Stale. States only one page has come after these, in plain words
   (Not Connected, No Sessions). There is no "Coming Soon" state.
   **Why:** the same state sits in the same place on every page, so a missing
   one stands out.
3. **Then variants:** tabs, other views, flag arms, Dark, Narrow, desktop.

**Tabs are stories** on their page's entry (`Session Detail` › `Activity
Tab`), not entries of their own. **Why:** in Storybook an entry cannot be
both a folder and a story, and this keeps titles short.

Session, Branch, Document and Issue Detail are the one exception to the
order: their Default and tab stories show the new PRD-751 page, and the page
the app ships today follows as the `Live` stories (`Live`, `Live Loading`,
...). Document and Issue Detail joined in 2.0.31 (ISS-12586), and so did
Documents List and Issues List, whose Default and Dark show the list design
shell.

### States: a dropdown and a named story (ISS-10550)

1. **Every state gets a dropdown Control.** A prop with a small, known set of
   values (`state`, `status`) is a `select` (or `inline-radio` for 2 to 5
   values) with a literal `options` list. **Why:** the dropdown shows every
   value that exists, and the literal list also reaches the component
   manifest agents read.
2. **Behavioural states also keep their own named story.** Loading, empty,
   error, not found, no permission: anything that changes behaviour or
   layout. **Why:** a dropdown value has no story ID. It cannot be linked in
   a bug report, opened by an agent, snapshotted, or given its own test. A
   named story can.
3. **A visual option on an existing variant is a Control** (tone, size,
   density), not a story per value. **A new variant or visual mode still gets
   its own named story export** (`packages/design-system/AGENTS.md`, "Adding a
   variant to an existing component"), so it has a story ID like a state.
4. **Full pages (Surfaces) are the exception to rule 1.** Their fixtures are
   too structured for a live Control, so the named stories carry the states.
   Say so in the story file.

### Names

- **Use the app's own names** for pages and tabs: `Sessions List`,
  `Session Detail`, `Activity Tab`. No "V2", "Surface" or "Page" in a new
  title. **Why:** you search Storybook for what you see on screen.
- **A tab story is its on-screen label plus "Tab"**: Artifact Tab, Details
  Tab, Sessions Tab, Activity Tab.
- **Story names are plain words in Title Case**: Default, No Matches,
  Not Found.
- **Depth:** a page or pattern title is at most four levels
  (`Surfaces/Artifacts/Sessions/Session Detail`). A section adds its
  own name under the page, so a composite can be five. **Why:** deeper
  than that, nobody can scan the sidebar.

### Titles: computed or typed, and always checked

- **Computed:** every story in the component catalog (design-system,
  `packages/app` and desktop stories, including pattern stories that live
  next to their shell). `pnpm --filter storybook catalog:sync` works out the
  title but writes it only to `component-catalog.ts`; it does not touch the
  story file. To retitle: run `catalog:sync`, then copy the computed title
  into the story's `meta.title` (`validate:catalog` fails while they differ
  and prints the expected one), and commit both. A composite in the
  catalog is placed by `V2_PLACEMENT_BY_ID`
  (`scripts/taxonomy-classification.mjs`).
- **Typed by hand:** the current story files under `apps/storybook/stories/`:
  `surfaces-v2/`, `patterns-v2/`, `foundations-v2/` and `composites-v2/`,
  including each root's Overview page. They are not in the catalog, so
  `catalog:sync` does nothing for them: edit `meta.title` and the page-tree
  order yourself. `validate:catalog` checks that
  each title starts with its root, is not too deep, is listed in the
  order in `story-group-order.ts`, and is unique. It says what is wrong, but
  it does not print a corrected title.
- A new page goes into `storybookSurfacesV2Order`
  (`story-group-order.ts`) first; anything placed under it comes after.
- A story is only picked up from a scanned directory (`apps/storybook/AGENTS.md`).

**Why:** when anyone could type any title, components landed wherever
someone put them, and nobody could tell what belonged where. Computing a
title where possible, and checking every hand-typed one against a single
list, catches a wrong title before it ships.

### Where to look

- Hosted, no login: https://prototypes.preview.stage.example/storybook/
  (it updates when `main`'s CI batch passes, from the `green` branch, so a
  merged change can take a little while to appear). Only a `prototype/`,
  `vibe/` or `functional-prototype/` branch gets its own preview (its
  `prototypes` preview URL plus `/storybook`); review any other branch in a
  local Storybook (ISS-12353).
- Every title, without building: in `apps/storybook`, run
  `pnpm exec storybook index -o <file>`.

## For designers

A plain-language guide to using this Storybook with Claude. You do not need to
know how to code to use any of this.

### What Storybook is

Storybook is a living catalog of every piece of the product's interface.
Buttons, cards, tables, charts, whole pages. Each piece is shown on its own so
you can look at it closely, poke at it, and see how it behaves.

Think of it as the design file, except it is showing you the real thing the
engineers ship, not a picture of it. If it looks a certain way here, that is
how it actually looks in the product.

### Just want to look at it?

Open this. Nothing to install, no login.

**https://prototypes.preview.stage.example/storybook**

It lives inside the `apps/prototypes` deployment rather than a Vercel project
of its own: operator ruling, 2026-09-07 (Marisol Ashgrove), reaffirmed
2026-09-18; the full record is in `docs/design/storybook-governance.md`
§ Hosting. It does not update on every merge: it follows the `green`
branch, which moves to `main` only when `main`'s CI batch passes, so a merged
change can take a little while to appear. If something that just shipped is
missing, check back shortly. For something still in review on a `prototype/`,
`vibe/` or `functional-prototype/` branch, use that branch's own preview URL
plus `/storybook`; other branches get no preview (ISS-12353), so run the
Storybook locally.

If you do not know what something is called, start at `Start Here/Catalog`:
a searchable index of every component, with a preview of each. The sidebar
order is explained in "The short version" above.

That covers everything below except making changes. If you only need to
review components, stop here.

### Getting set up to make changes

Only needed if you are going to edit something. Ask whoever gave you this repo
which branch has the work you're looking for. Storybook work lives on
short-lived branches that are reviewed and merged, not on one long-lived
branch.

```
git clone https://github.com/closedloop-ai/closedloop-ai.git
cd closedloop-ai
pnpm install
```

Start it up:

```
pnpm -C apps/storybook dev
```

Then open the address it prints, usually `http://localhost:6006`.

### The three things worth knowing

**Switch light and dark.** There is a control in the toolbar at the top. Every
component should look right in both. If one does not, that is a real bug worth
reporting.

**Change the settings yourself.** Under most components there is a Controls
panel. It lists that component's options: the text it shows, whether it is
disabled, which size it is. Change any of them and the component updates as
you watch. Nothing you do here can break anything, and refreshing the page
puts it all back.

**Many states are already built.** Many components have several stories
listed under them in the sidebar: Loading, Empty, Error, too much text. They
are the situations designers usually forget to check. Not every component
has every state yet.

### Working with Claude on this

You can ask Claude to make changes to what you see. The trick is being
specific about which component you mean.

Copy the name from the sidebar. If you are looking at "Composites / Branches /
Branches Summary Cards", say exactly that. Claude can find it instantly from
that name.

Things that work well:

- "In Composites / Branches / Branches Summary Cards, the explanation text
  under the number is too long and competes with the number. Move it into the
  little info icon instead."
- "Show me every component that uses the warning color."
- "Add a story showing what Sessions looks like when someone has a hundred of
  them."
- "Does this component work on a narrow screen? Show me."

Things to avoid:

- "Fix the card." There are dozens of cards. Name the one.
- "Make it look better." Say what is wrong. Too cramped, too loud, hard to
  read.

### A good habit

When something looks off, screenshot it and paste it to Claude along with the
component name from the sidebar. A picture plus a name is usually all it
needs.

### If something looks broken

Some components need data to render. If you land on one and it is blank or
shows an error, that is usually a missing setup detail, not a design problem.
Say which story it was and it can be fixed.

---

## The detail behind the rules

The sidebar order is built by `buildStorySortOrder` in
`story-group-order.ts`. `Start Here` shows no lifecycle badge, nor does
anything under it (`.storybook/manager.ts`).

`Primitives` and `Composites` hold the components added after the
v1.0 baseline, so each root holds one release: `Primitives v1.0` and
`Composites v1.0` stay pure v1.0. `catalog:sync` titles a story by its
lifecycle tag: `deprecated` under `<Level> v1.0/`, any other under
`<Level>/` (`storybookVersionedLevels` and `storybookReleaseOfLifecycle` in
`story-group-order.ts`). Primitives keeps the element-kind groups of its v1.0
root; Composites follows the page tree (below).

`Foundations` started as an exact copy of the five Foundations pages
(2026-10-06) and is where token changes go, while `Foundations v1.0` stays
as it was. The pages document tokens rather than components, so they have no
catalog entry: they live under `stories/foundations-v2/`, are tagged `stable`,
and `validate:catalog` checks their titles against the Foundations groups in
`story-group-order.ts`. `Foundations/Colors` shows every value as hex,
and its Primitives story is the primary colour library that semantic tokens
will be drawn from: curated from the Figma Primitives export into
`stories/foundations-v2/tailwindcss-colors.json`, with Zinc as its one grey
scale.

v1.0 titles are `<Level> v1.0/<Group>/<Component>`; Foundations is flat. v1.0
Surfaces is grouped by artifact type (`Surfaces v1.0/Sessions/Listing`,
`Surfaces v1.0/Sessions/Session Detail`); a surface that is not an artifact type
(Dashboard, Login, Settings) stays flat, decided per surface by
`SURFACE_OVERRIDE_BY_ID` in `taxonomy-classification.mjs`.

## The page tree (rules, 2026-10-06)

The current Storybook is organised by page. Surfaces defines the tree of
pages; Composites and Patterns follow the same tree, so everything that makes up a page
sits at that page's path in each root. The tree is `storybookV2PageTreeOrder`
in `story-group-order.ts`: a `Shared` group first, then the Surfaces tree
(`storybookSurfacesV2Order`).

| Level | What it is | Where it sits | Title |
|---|---|---|---|
| Foundations | Tokens: colour, type, spacing, radius, motion | Flat, the same pages as Foundations | `Foundations/<Page>` |
| Primitives | One cohesive element, not tied to any page | The v1.0 element-kind groups | `Primitives/<Group>/<Name>` |
| Composites | A **section** of a page, with real content: a panel, a tab body, a rail, a control group | Under the page that uses it | `Composites/<page path>/<Name>` |
| Patterns | A page's **shell or layout**: its frame, regions and how they respond to width. **No content**: every slot is an empty, named region | At the page's own path | `Patterns/<page path>` |
| Surfaces | A **finished page**: the live app's own page, with every element it has, fed with fixture data | At its path in the tree | `Surfaces/<page path>` |

How they link:

- **A Surface is the live page (Nerys, 2026-10-06).** A Surfaces story
  renders the live route's own page component (`@/app/...`), not a copy of
  it, inside the Global Nav of `Composites/Shared/Navigation/Sidebar`
  (`stories/surfaces-v2/live-page.tsx`), with API reads answered by
  `parameters.appCore.apiRoutes` (`stories/surfaces-v2/fixtures/`). Each story
  is a state the live page reaches. Storybook answers Clerk with a signed-in
  stand-in (`.storybook/clerk-nextjs-mock.tsx`), and the document editors take
  their room-less path (`.storybook/collaboration-room-utils-mock.ts`).
  Desktop-only pages render the desktop view in the desktop app's frame.
  Session Detail and Branch Detail are the exception (Nerys, 2026-10-06), and
  Document and Issue Detail since 2.0.31 (ISS-12586):
  their stories render the PRD-751 page (the artifact detail shell with its
  tab set, as in Patterns) in the same frame, and the page the live app
  ships today follows as the `Live` stories. Both follow the web-master generic
  artifact prototype's chrome: a page header row (the route header's
  breadcrumbs, with the comments toggle at its end beside the rail), then the
  tab row ending with the collaborators. The same parts are the Patterns
  regions (Breadcrumbs, Comments toggle, Collaborators) and the Composites
  sections under each page (Page Header and one item per tab) plus
  `Shared/Artifact Detail/Collaborators`.
- **A page with no new version shows its pattern (Nerys, 2026-10-14,
  ISS-12171).** Every page the artifact template needs has a Surfaces
  entry, even before the page exists. When the live app has no such page yet
  (PRDs List, Plans List) or only a placeholder, the entry
  renders its Patterns layout in the app frame instead of a complete
  page; a placeholder the route renders today stays as the `Live` story. The
  entry is filled in when the page's new version is built.
- **One layout, one file.** Pages that share a layout render the same
  pattern component: every v2 list is `stories/patterns-v2/artifact-list-layout.tsx`
  (the `GridTableListSurface` bands), and Document, PRD, Plan and Issue
  Detail are `document-detail-layout.tsx` (the artifact detail shell under
  the editor's route header, as `DocumentEditorScaffold` renders it). Each
  page still has its own pattern entry at its own path.
- **A Surface is built from one Pattern and Composites.** A Surfaces page
  renders its pattern's shell with the Composites sections in its
  regions. A composed page is authored in its Surfaces file (for
  example `Surfaces/Artifacts/Branches/Branch Detail`), never in
  Composites: a whole page is not a section.
- **A Pattern is the page without its content.** It uses the same shell and
  the same per-page rules as the Surface (tab set, which tabs show the
  comments rail), with an empty, named region in every slot
  (`ShellHarness layoutOnly`). Mechanics stories may put neutral fixtures in a
  region when the behaviour needs one, such as a crowded header.
- **A Composite sits under the deepest page every user of it shares.** Used
  only on Session Detail: `Composites/Artifacts/Sessions/Session Detail/…`.
  Used on the Sessions list and Session Detail: `…/Artifacts/Sessions/…`. Used
  by pages in more than one part of the tree: `Shared/<kind of page>`, for
  example `Composites/Shared/Artifact Detail/Collaborators`, a section of
  every artifact detail page. A shared section with several parts of its own
  gets its own group: `Composites/Shared/Activity` holds the Activity
  tab's timeline, its activity row and its comment box (ISS-12117).
  `Composites/Shared/Artifact List` holds the parts the Sessions,
  Branches and Documents lists share: the list band layout, the card list
  and the Add Tag picker (ISS-12305).
  `Composites/Shared/Data Sync` holds the data-sync level card every
  consent and settings surface draws (ISS-12522) and the directory scope
  list, with and without its add control (ISS-12520, ISS-12521).
  `Composites/Shared/Data Controls` holds the parts every data-controls
  page shares, starting with the policy status indicator (ISS-12526), the
  deletion scope review (ISS-12537), the deletion request tracker
  (ISS-12538), the uploads pause control (ISS-12528), the scope editor
  (ISS-12527), the deletion entry point (ISS-12539) and the upload queue
  view (ISS-12529). A section of the guided-onboarding card sits under
  `Composites/Onboarding`, the page it belongs to: the Web setup gate rows
  (ISS-12363) and the directory step (ISS-12524).
- **The same name means the same page in every root.**
  `Patterns/Artifacts/Sessions/Session Detail`,
  `Composites/Artifacts/Sessions/Session Detail/*` and
  `Surfaces/Artifacts/Sessions/Session Detail` are the layout, the
  sections and the finished page of one page.
- **Primitives and Foundations are not placed by page.** They are the
  vocabulary every page draws from.

Enforcement:

- `V2_PLACEMENT_BY_ID` in `taxonomy-classification.mjs` places every current
  Composite and Pattern (`level` and `path`). `catalog:sync` computes the title
  from it and fails for a current Composite with no placement; `validate:catalog`
  fails when a placement's path is not a node of the page tree, or a story
  file's title does not match.
- A new page goes into `storybookSurfacesV2Order` first; Composites and
  Patterns can then be placed under it.
- Depth: a Surfaces or Patterns title is at most four levels
  (ISS-11361). A Composite adds its own name under the page, so it can be five.
- State order (ISS-12332): every Surfaces, Patterns and
  Composites entry lists its stories as Default, then the shared states
  in this order: Loading, Syncing, Empty, No Matches, Error, Not Found,
  No Permission, Unavailable, Stale; then the states only that page has;
  then variants (tabs, views, flag arms, Dark, Narrow, desktop). A state an
  entry does not have is skipped. **Why:** a missing state stands out, and a
  page's Surface, Pattern and Composites read the same way. The check looks
  at one entry at a time; the three levels agree because each one follows
  this same order, not because they are compared with each other.
  - **Default.** With no story named Default, the first story plays that
    part and stays first, even when its name is a shared state: an entry
    that opens with Error keeps Error first.
  - **Prefix rule.** A story named after a shared state plus more words sits
    with that state: Loading Dark and Loading Summary with Loading, Error With
    Retry with Error, Empty Window with Empty. So "Loading More" also counts
    as Loading. Only the start of the name counts: Cards Error is a variant.
  - **Older names.** A few existing stories use another name for a shared
    state; `storybookStateSynonyms` maps them (Permission → No Permission,
    No Sessions → Empty, Failed Retrieval → Error, Load Failed → Error,
    Failed Load → Error). Name a new story with the shared word instead.
  - **What is checked.** `pnpm check:storybook-state-order` (in the husky
    pre-push gate and the required `lint` job) and `validate:catalog` fail an
    entry whose Default or shared states are out of place, and print the order
    to use (`scripts/story-state-order.mjs`; the list is
    `storybookSharedStateOrder` in `story-group-order.ts`). The check cannot
    tell a page's own state from a variant by name, so putting page states
    before variants is up to the author: Sign In and Sign Up had Narrow
    before Clerk Load Failed until 2.0.26. An exemption whose entry is
    already in order fails the check, so the list cannot go stale. v1.0 is
    not checked.

Composites, Patterns and Surfaces each open with an Overview
page: what the root holds, what does not belong there, and how the three
link (`stories/composites-v2/`, `stories/patterns-v2/`, `stories/surfaces-v2/`,
sharing `stories/v2-overview-page.tsx`). Each is the first entry of its
root's sort order.

A v1.0 component copied into Composites, so the current Storybook can change without
touching v1.0, is a story file in `stories/composites-v2/` named
`v2-<name>.stories.tsx` (a `<name>.stories.tsx` would share the v1.0 story's
stem, which `catalog:sync` keys on). Its title is
`Composites/<page path>/<Name>`, placed by the same rules as any
composite; `validate:catalog` checks that the page path is in the tree. The
Sidebar (`Composites v1.0/Navigation/Sidebar` in v1.0) is a section of every page,
so its copy is `Composites/Shared/Navigation/Sidebar`.
The pattern stories themselves are colocated with their shell
(`branch-artifact-shell.stories.tsx`, `session-artifact-shell.stories.tsx`,
`artifact-detail-shell.stories.tsx`) and titled by `catalog:sync`, or sit in
`stories/patterns-v2/` with a hand-typed title (the list and document detail
patterns).

`Surfaces` is the last of the current roots. It holds the ISS-11361 page
tree (stories under `stories/surfaces-v2/`) and sits beside `Surfaces v1.0`,
the Deprecated baseline. Its
order is `storybookSurfacesV2Order` in `story-group-order.ts`, and
`validate:catalog` checks that every v2 title starts with the root, is at most
four levels deep and is listed in that order.

### How a Surfaces story is built

Every page entry renders the live page (see "A Surface is the live page"
above), except a page with no new version yet, which renders its pattern; the
root's Overview is the only entry that is not a page. A story file is
`stories/surfaces-v2/v2-<page>.stories.tsx`, and its meta:

- `render`s the route's own page component inside the frame for where that
  page lives (below).
- answers the page's API reads with `parameters.appCore.apiRoutes`, built from
  `stories/surfaces-v2/fixtures/`, and turns on the PostHog flags the live page
  runs with in `parameters.appCore.enabledFlags`.
- puts the page at its live URL with `parameters.liveRoute: { path, params }`
  and the `withLiveRoute` decorator (`live-route.tsx`). Route components read
  their path, query and dynamic segments (`[id]`, `[branchId]`) to decide what
  to render, so a page is mounted at its own path with the params Next.js
  would hand it.
- turns Controls off. Each story is one state the live page reaches, made by
  changing the fixture routes or the URL: a read that never resolves is
  Loading, a failed read is Unavailable or Error, an empty list is Empty, a
  filter in the URL that matches nothing is No Matches.

Session, Branch, Document and Issue Detail are the exception to this recipe
(see "A Surface is the live page" above): their `meta.render` renders the
PRD-751 design preview (`SessionDetailDesignPreview`,
`BranchDetailDesignPreview`, `DocumentDetailDesignPreview`,
`IssueDetailDesignPreview`) in `LivePage`, so `Default` and the tab stories
show the new page. Only their `Live` stories (`Live`, `Live Loading`…)
override `render` with the shipped route component. The Document and Issue
previews share one shell (`document-detail-design-shell.tsx`); the Issue
Artifact tab is four labelled stand-ins, each filled by its own design ticket
(DI-07 to DI-10).

| Where the page lives | Frame | File |
|---|---|---|
| The authenticated web app | `LivePage`: the Global Nav and the content column | `live-page.tsx` |
| A document route (Document, Issue, PRD, Plan detail) | `DocumentRoutePage`: the route's editor container at `/<org>/<segment>/<slug>[?version=N]` | `document-route-page.tsx` |
| A Settings panel | `SettingsLivePage`: the app frame with the Settings dialog open on `?panel=<id>` | `settings-live-page.tsx` |
| A signed-out screen (Sign In, Sign Up, SSO Callback, GitHub Connect, GitHub Link) | `AuthPage`: the live `(unauthenticated)/layout.tsx`, no Global Nav; `withClerkState` and `withFastForward` set the Clerk stand-in and the screen's timers | `auth-page.tsx` |
| The desktop app only | `DesktopPage`: the desktop renderer's view in the desktop shell's frame, with the Electron preload bridge stubbed. Desktop flags come from its `flags` prop (read through the stubbed bridge), not `appCore.enabledFlags`, so a page behind a desktop nav gate passes its key there | `test/desktop-page.tsx` |

Two cases have no frame of their own. When a route is an async server
component, the story renders the tree that page returns with the choice the
server would make: Packs List and Pack Detail (`fixtures/packs-page.tsx`) pick
admin or member mode from the Clerk role, as `packs/page.tsx` does; the
document and Settings frames do the same for their routes. When the live
layout renders a component instead of its shell, the story renders that
component alone: API Unreachable is `UnreachableApiNotice`, which the
authenticated layout returns on a per-deployment preview host (ISS-9797).

A fixture that a windowed list reads (one that narrows its rows to a default
date range, such as Branches List and Documents List) builds its instants with
`createFixtureInstant` (`fixtures/fixture-clock.ts`, ISS-12442), which moves
them onto the days ending yesterday. A pinned ISO date falls out of the window
on a calendar boundary and empties every story that needs rows.
`__tests__/surfaces-v2-fixture-window.test.ts` holds both callers to that.

`compose.tsx` (`fromSource`, `planned()`) is from the first Surfaces
pass, when pages were arranged from existing stories and planned slots. No
Surfaces story uses it now; only `__tests__/surfaces-v2-compose-help.test.tsx`
imports it.

This scheme was ported from the closedloop-ai Community Edition (CE) fork's own
taxonomy rework (PLN-2024). CE runs against a sanitized, much smaller snapshot of
this codebase, so its version of this document was written against roughly 335
components across 12 domains. This version is written against the real thing:
about 398 components once you count the design system, the app's colocated
feature stories, and the desktop shell. The levels and the rules below are
unchanged. The **groups are not** — see "The groups" below.

## Where the code lives does not matter

This is the rule the whole structure hangs on.

A component's title is decided by what it is, never by whether it sits in
`packages/design-system`, `packages/app` or `apps/desktop`. Storybook's own
history here makes the point: `component-catalog.ts` used to key its sections
off `Design System` and `App Core`, two labels that told you which package a
file lived in and nothing about what it was. That distinction disappears in this
scheme. `packages/app/shared/components/tag-color-picker.tsx` and
`packages/design-system/components/ui/badge.tsx` can both be Primitives; a
1,588-line `session-trace.tsx` living in `packages/design-system` would still be
a Composite.

Desktop is the one place code location still shows up in the title, and only
because the Electron shell genuinely renders a different family of surfaces
(onboarding dialogs, sync status, startup readiness) with no web equivalent to
share a name with. Those 21 components are `Composites v1.0/Desktop Shell/*`. Nothing
else in `apps/desktop` gets special treatment: if a desktop story is a variant
of a shared surface rather than a shell-only concern, it stays under that
surface's own title.

## The four levels (v1.0, Deprecated)

**Foundation.** Documents tokens, not components. Five of them — Colors,
Typography, Spacing, Radius & Elevation, Motion — each reading its values out
of the DOM at runtime so they cannot drift from `globals.css`. Motion shipped
first (PLN-2024 Phase A.2); the other four landed in the parity pass that
brought Surfaces up to CE's structure, once every token they reference was
verified to exist unchanged in closedloop-ai's real `globals.css` (it did —
this was a near-verbatim port, not a rewrite).

The old `Foundations v1.0/Chart Colors` placeholder is retired: it held the chart
token palette under the pre-taxonomy `Design System/Data Display/Data
Visualization` section, and folds into `Foundations v1.0/Colors`'s own "Chart
series order" section now that the real page exists, exactly as planned.

**Primitive.** Renders as one element. Wrapping a third-party control still
counts: `Select` wraps Radix, `Calendar` wraps react-day-picker, and both are
still one control. Give it an element kind (below).

**Composite.** Built from primitives. If you can point at the parts, it is a
composite. Give it an element kind if it is generic, a domain if it is bound to
a product feature.

**Surface.** Composes composites into a page or a full region of one. Two
shapes, both hand-curated (this level is a reviewed list, not a derived
result — see "Surfaces is a reviewed list" below):

- **Promoted composites.** Nine of the surfaces below are an existing
  Composite's own story, retitled — `Pack Detail`, `Packs Workspace`,
  `Session Transcript Panel`, `Comments Workspace`, `Agent Detail`,
  `Branch Detail Page`, `Session Detail`, `Session Detail (Desktop Shell)`
  and `Sessions/Listing` all render the exact same real, shipped component
  their Composite story already did — nothing rebuilt, just a title that
  says what it is at the top of the app rather than a piece of one.
  `SURFACE_OVERRIDE_BY_ID` in `taxonomy-classification.mjs` is the list.
  Two entries were promoted here once and un-promoted 2026-09-18 (Mordecai,
  storybook review): `Data Sync Tab` and `Withheld Section` are each a
  section of a larger real page (a Settings panel, a Diagnostics-surface
  region), not a page of their own, and now sit where the rest of that
  reasoning already puts pieces like them — `Composites v1.0/Desktop Shell/Data
  Sync Tab` and `Composites v1.0/Diagnostics/Withheld Section`.
- **Hand-composed pages.** `Dashboard`, `Login`, `Settings` and `Onboarding`,
  plus the artifact-type pairs — `Documents` (Listing +
  Document Detail), `Projects` (Listing + Project Detail), `Issues` (Issue
  Detail), `PRDs` (PRD Detail) and `Implementation Plans` (Plan Detail) — are
  real composition files under `apps/storybook/stories/surfaces/`,
  assembling the real composites a current closedloop-ai route actually
  mounts. `Sessions/Listing` was itself a hand-composed page originally
  (`SessionsToolbar` / `SessionsSummaryCards` / `SyncedSessionsTable`) and is
  now a promoted composite instead — the real `/sessions` route renders
  `sessions-list-surface-v2` directly, behind the grid-table-v2 gate, so the
  hand-composed approximation was retired in its favor (see that story
  file's own header). Every import across these pages was checked against
  closedloop-ai's actual current source before being trusted, not assumed
  from CE's month-old snapshot — one real divergence turned up doing that for
  Login: `AuthMethods` no longer accepts a `showEmail` prop (ISS-5954 retired
  it, specifically to stop hosts drifting into different auth option sets),
  so Login's composition reflects that removal rather than porting CE's
  now-inaccurate control for it. The one page-level state neither shape can
  borrow is the route's own data layer — a client component's query state —
  so each surface reproduces the states that layer produces as explicit
  Storybook controls instead of faking a network mock.

Two of CE's original sixteen don't have a closedloop-ai equivalent and are
deliberately not forced: **Session Activity Breakdown** has no matching
component here at all (checked; genuinely doesn't exist), and
**Telemetry Analytics** no longer does either — ISS-10733 deleted
`agent-telemetry-analytics.tsx`, which was cataloged as a Composite that
no real route mounted.
Both stay documented gaps rather than silently-dropped or wrongly-forced
entries. Everything past CE's original sixteen — Documents, Projects, Issues,
PRDs, Implementation Plans, Onboarding — is closedloop-ai's
own artifact-type coverage, added after the CE parity pass and reviewed
against a real route the same way, not part of the original port.

## The groups

Two vocabularies, and only one of them is closed. Element kinds are a fixed
set — adding one is a deliberate edit here and in
`taxonomy-classification.mjs`'s `designSystemGroup`, not something that
happens by writing a title. Domains are NOT closed the same way: `domainForFeature`
title-cases any `packages/app/<feature>` directory it hasn't seen an override
for into a new domain automatically, on purpose, so a team starting a new
feature never needs a taxonomy edit before their first story can land. The
`DOMAIN_TITLE_OVERRIDES` table exists only for the directories that title-case
into something wrong (`github` → `GitHub`, not `Github`), and the few named
exceptions (Sessions, App Shell) are the only genuinely hand-maintained part
of the domain vocabulary. Either kind of group still needs a `preview.tsx`
`storySort` entry to get a deliberate sidebar position — an unlisted group
still renders, just sorted after everything that is listed.

### Element kinds

Used by every Primitive, and by any Composite that is not bound to a feature.
Unchanged from CE — these are generic UI concepts and transfer directly.

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

**Data Display splits into two named sub-families**, which CE's version does
not: `Data Display/Tables` and everything else. The table and grid-table
tooling here is 43 components on its own — `grid-table`, `grid-table-v2` and
every menu, header, cell and pagination piece that goes with them — which is
larger than most of CE's entire domains. Flat under one group, it would be an
unscannable wall in a left nav. Same rule CE already uses for oversized domains
(below), applied to a group instead: **a group over about 25 stories splits into
named sub-families.**

### Domains

Composites only, for anything bound to a product feature. This is the vocabulary
CE's version got smallest wrong for this repo: CE lists 12 domains because its
snapshot only has 12 feature areas. The real app has 20 with stories today, one
per `packages/app/<feature>` directory (with one promoted out of its
directory — see Sessions below), derived mechanically rather than picked by
taste:

```
Agents  Branches  Compute  Diagnostics  Documents  Help  Inbox
Insights  My Tasks  Onboarding  Organizations  Packs  Projects
Search  Session Limits  Sessions  Settings  Tags
App Shell  Desktop Shell
```

Plus fourteen with the directory but no stories yet, kept in the vocabulary so a
story added there doesn't need a taxonomy edit first: `API Keys`, `Chat`,
`Custom Fields`, `Desktop` (`packages/app/desktop` — a distinct domain from
`Desktop Shell`, which is `apps/desktop`, a different source root entirely),
`Devices`, `GitHub`, `Google`, `Judges & Analytics`, `Linear`, `Pensero`,
`Ratings`, `Teams`, `Users`. 33 domains total, all of it
computed from `packages/app`'s and `apps/desktop`'s own directory listing —
re-derive it from that listing rather than trusting this list to stay
current by itself.

`packages/app/shared` and `packages/app/shell` merge into one domain, **App
Shell** — both hold cross-feature chrome (nothing in either is bound to one
product feature), and splitting them by directory would recreate the exact
"same kind of thing, two places" problem this whole scheme exists to avoid.

The **Artifact Detail** domain (2026-10-06, Storybook 2.0.4) is retired: its
parts were all v2.0, and v2.0 now places them by page ("The page tree",
above). The shared detail-page sections are under
`Composites/Shared/Artifact Detail`, the shell under
`Patterns/Shared/Artifact Detail`.

**Sessions is a domain, not a directory, and it does not live where its name
suggests.** `/sessions` is a real route, a peer of `/agents` and `/branches`
in the product — but its code sits under
`packages/app/agents/components/sessions/` for historical reasons. This is
the same fact `AGENTS.md`'s pre-taxonomy "Which `App Core/` section" guidance
already recorded ("Sessions is its own surface... a peer of `/branches` and
`/agents`, but its code lives under `packages/app/agents/components/sessions/`
for historical reasons") — carried forward into `taxonomy-classification.mjs`
as `resolveAgentsPackageDomain` rather than re-derived from the directory
listing, which would have gotten it wrong. Two components need a further,
per-id override on top of that directory rule, both named in the same source:
`cost-metric-card` (consumed by the Insights overview dashboard, despite
living in `sessions/`) and `active-runs-panel` (an agent-runtime dashboard
card, not part of the Sessions list, despite the same location).

**Agents is oversized (62 stories once Sessions moves out) and splits into
named sub-families**, same rule as Data Display above:

```
Composites v1.0/Agents/Detail       35   the session detail pane — timeline, trace, properties
Composites v1.0/Agents/Workspace    10   the workspace / pipeline view
Composites v1.0/Agents/General      17   everything else, plus active-runs-panel
Composites v1.0/Sessions            19   the sessions list and its parts (own domain, not a sub-family)
```

This is CE's own Sessions/Listing/Detail/Trace split, adapted to where the
code actually lives here — with Sessions promoted to its own domain rather
than kept as an `Agents/` sub-family, per the point above.

## How to classify something new

1. Does it document tokens? Foundation.
2. Does it render as one element? Primitive. Even if it imports `Button`, even if
   it wraps a third-party control. Give it an element kind.
3. Does it compose composites into a page or page region? Surface.
4. Otherwise Composite. Give it a domain if it is bound to a feature, an element
   kind if it is not.

Tie-breakers that come up constantly, in order of how often they bite:

- **A component that captures a value through an overlay is Inputs, not
  Overlays.** `Date Picker Popover`, the `Filter Popover` family, `User Select
  Popover`, `Command` — all render on a layer above the page, and all of them
  exist to capture a choice. The overlay is the mechanism; the value capture is
  the job. Generic overlay primitives with no value-capture job of their own —
  `Dialog`, `Popover`, `Tooltip`, `Dropdown Menu`, `Alert Dialog`, `Info Hint` —
  stay Overlays. This is the one rule CE's version didn't need, because CE has
  far fewer popover-driven inputs; it is written down here because the wrong
  call is easy to make component-by-component and inconsistent across two
  reviewers otherwise.
- A badge or icon whose job is to report state (loading, synced, healthy, failed)
  is **Feedback & Status**, not Data Display.
- Anything that is a tooltip is **Overlays**, whatever it contains — with the
  value-capture exception above.

## The judgment calls, and why

### A single dependency does not make you a composite

The same trap CE documented, present here too: dozens of components import
exactly one other component, usually `Button`, and calling all of them
composites would shrink Primitives to a rump and make the level meaningless.
**The line: one dependency is still a primitive if the thing renders as one
element.** `Copy Button` imports `Button` and stays a primitive. `Kanban Board`
imports one component and is plainly a composite, because it renders a board.

### The import graph measures reuse, not complexity — worse here than in CE

CE found 29 components with this shape (zero design-system imports, over 200
lines) and flagged two extreme cases. This repo has the same trap at a larger
scale: `session-trace.tsx` is 507 lines and imports nothing from the design
system, `trace-harness-tags.tsx` is 561, `sessions-summary-cards.tsx` is 751.
By import count alone all three are primitives, which is obviously wrong — they
are not built from shared parts because they build everything inline instead.

**The fix, made mechanical rather than argued case by case:** among the
zero-design-system-import candidates, anything over 150 lines, or whose name
matches `panel|surface|summary-cards|trace|timeline|breakdown|waterfall|
properties$`, is reclassified as a Composite bound to its feature's domain. That
pattern catches the session-timeline family, the settings panels, and the
branch waterfall/cost components — 18 of the 50 original zero-import
candidates — without a person having to open all 50 files and decide. The
remaining 32 are genuinely small, single-element things (`Favorite Button`,
`Session Provenance Chip`) that happen to live inside a
feature package; they stay Primitives with an element kind, per the rule above
that location never decides the level.

This is a coarser instrument than CE's own manual review of its two worst
offenders, traded deliberately for one that scales to hundreds of components
without hand-reviewing each one. It will misclassify some edge cases in either
direction. Fixing an individual one is a one-line edit to the override table in
`sync-component-catalog.mjs`, not a reason to distrust the whole rule.

### Surfaces is a reviewed list

CE's Surfaces was "a reviewed list, not a line count" — 16 pages,
hand-approved one at a time. This repo's list is the same shape, checked
against closedloop-ai's own current routes and components rather than
assumed from CE's, and has grown past CE's own scope to cover
closedloop-ai's real artifact types (Documents, Projects, Issues, PRDs,
Implementation Plans) plus Onboarding:

```
Agent Detail                 Branch Detail Page           Comments Workspace
Dashboard                    Document Detail              Documents/Listing
Implementation Plan Detail   Issue Detail                 Login
Onboarding                   Pack Detail                  Packs Workspace
PRD Detail                   Project Detail               Projects/Listing
Session Detail               Session Detail               Session Transcript Panel
                             (Desktop Shell)
Sessions/Listing             Settings
```

Twenty, grouped by artifact type where one applies (Sessions, Branches,
Agents, Packs, Documents, Projects, PRDs, Implementation Plans — each
surface's listing and single-artifact screen sit together, `TAXONOMY.md`'s
"The groups" explains why) and flat where it doesn't (Dashboard, Login,
Settings, Onboarding). Adding one is a deliberate edit to
`SURFACE_OVERRIDE_BY_ID` (a promoted composite) or a new file under
`apps/storybook/stories/surfaces/` (a hand-composed page), reviewed against a
real current route the same way these twenty were — that is the point of
the level being a list rather than something a title alone can produce.
Session Activity Breakdown and Telemetry Analytics remain the two CE names
with no honest closedloop-ai equivalent (see above); Data Sync Tab and
Withheld Section were promoted and then un-promoted (see above) and are not
missing entries, they are Composites now. Two v1.0 surface entries were added
after this list, `Surfaces v1.0/Sessions/Agent Session Shell View` and
`Surfaces v1.0/Branches/Branch Shell View`, so v1.0 Surfaces has 22 entries
(story index, 2026-10-09). New pages go into Surfaces, not here.

## The catalog computes titles, stories do not declare them

`packages/design-system/storybook/component-catalog.ts` is generated by
`catalog:sync`. Its `level` and `pathSegments` are COMPUTED by
`scripts/sync-component-catalog.mjs` from the classification tables described
above — never read off a story's own `meta.title` — and each story's
`meta.title` is generated FROM them, which is what Phase C's retitle pass did.
A story therefore does not need an already-correct title to be classified
correctly, and `validate:catalog` is what holds the on-disk title to the
computed one. The classification runs once at `catalog:sync` time and is then
held fixed — not re-derived on every Storybook load — so a component's group
does not silently drift if its import graph changes without a person reviewing
the new title.

## Counting what is there

Do not trust a count written in a document, this one included: read the story
index ("Where to look", above). On 2026-10-09 it held 532 entries and 2,702
stories: Start Here 3 entries, Foundations 5, Primitives 1,
Composites 35, Patterns 5, Surfaces 63, Foundations 5,
Primitives 95, Composites 298, Surfaces 22. When the taxonomy was introduced
(PLN-2024 Phase B) the catalog held 398 components. The Primitives/Composites
split moved once after that: the import-count rule only matched the
`@repo/design-system/...` import form, and resolving relative imports too
moved about 45 components from Primitives to Composites.

## A note on renaming cost

Story ids come from titles, so every retitle resets any Chromatic baseline
that exists for that story — worth flagging even though nothing in this
repo's CI currently runs a Chromatic build to populate one
(`docs/design/storybook-governance.md`: Chromatic "was not chosen" for
hosting; `@chromatic-com/storybook` and the `chromatic` package script exist
but aren't wired into a workflow). This taxonomy's introduction retitles all
398 stories in one pass (PLN-2024 Phase C) for exactly the reason CE's own
note gives: nothing changes visually, but each one needs approving once, and
that is worth doing in one
batch rather than trickling across many PRs.
