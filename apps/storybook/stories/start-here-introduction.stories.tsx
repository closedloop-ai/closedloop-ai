import type { Meta, StoryObj } from "@storybook/react";

const LEVELS = [
  {
    name: "Foundations",
    description:
      "The tokens themselves: colour, type, spacing, radius, motion. Flat — no groups.",
    example: "Foundations/Motion",
  },
  {
    name: "Primitives",
    description:
      "Renders as one element. Wrapping a third-party control still counts.",
    example: "Primitives/Data Display/Person Avatar",
  },
  {
    name: "Composites",
    description:
      "Built from primitives. A section of a page, grouped under the page that uses it, the same tree as Surfaces.",
    example: "Composites/Artifacts/Sessions/Session Detail/Session Trace Chart",
  },
  {
    name: "Patterns",
    description:
      "Page shells and page layouts, with no content: every region is empty and named. A pattern sits at the same path as its page.",
    example: "Patterns/Artifacts/Branches/Branch Detail",
  },
  {
    name: "Surfaces",
    description:
      "A finished page: one pattern filled with composites, at the same path as both.",
    example: "Surfaces/Artifacts/Branches/Branch Detail",
  },
] as const;

// Storybook's own feature lifecycle (ISS-12610), shown as the sidebar badge.
const LIFECYCLE = [
  {
    name: "Stable",
    description: "Done, and matches the live app. Safe to build from.",
  },
  {
    name: "Preview",
    description:
      "Built and nearly final, still being reviewed or adjusted. Labs pages sit here.",
  },
  {
    name: "Experimental",
    description:
      "Design-only or exploratory, with no live counterpart yet: pages not in the live app, and design previews.",
  },
  {
    name: "Deprecated",
    description:
      'The v1.0 baseline, under the "v1.0" roots at the bottom. Frozen and on its way out; do not build from it.',
  },
] as const;

const IntroductionPage = () => (
  <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
    <header className="space-y-2">
      <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
        Start Here
      </p>
      <h1 className="font-semibold text-3xl tracking-tight">
        What this Storybook is, and how it's organized
      </h1>
      <p className="max-w-2xl text-muted-foreground text-sm">
        Every story title tells you what a thing <em>is</em> before it tells you
        what it's called — not which package its code happens to live in. The
        full rules, including the judgment calls and why they landed where they
        did, live in <code>apps/storybook/TAXONOMY.md</code>. This page is the
        short version.
      </p>
    </header>

    <section className="space-y-4">
      <h2 className="font-semibold text-xl tracking-tight">Five levels</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {LEVELS.map((level) => (
          <article
            className="space-y-2 rounded-lg border bg-card p-4 shadow-sm"
            key={level.name}
          >
            <h3 className="font-medium">{level.name}</h3>
            <p className="text-muted-foreground text-sm">{level.description}</p>
            <p className="text-muted-foreground text-xs">
              <code>{level.example}</code>
            </p>
          </article>
        ))}
      </div>
    </section>

    <section className="space-y-3">
      <h2 className="font-semibold text-xl tracking-tight">Lifecycle</h2>
      <p className="text-muted-foreground text-sm">
        Every story carries one stage from{" "}
        <a
          className="underline"
          href="https://storybook.js.org/docs/releases/features"
        >
          Storybook's feature lifecycle
        </a>
        , shown as the badge beside it in the sidebar. A folder shows a badge
        when everything inside it is at that stage. Work moves Experimental,
        Preview, Stable; Start Here/Version History records each move.
      </p>
      <dl className="divide-y rounded-lg border">
        {LIFECYCLE.map((stage) => (
          <div
            className="grid gap-1 p-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4"
            key={stage.name}
          >
            <dt className="font-medium text-sm">{stage.name}</dt>
            <dd className="text-muted-foreground text-sm">
              {stage.description}
            </dd>
          </div>
        ))}
      </dl>
    </section>

    <section className="space-y-2">
      <h2 className="font-semibold text-xl tracking-tight">
        Where the code lives does not matter
      </h2>
      <p className="text-muted-foreground text-sm">
        A component's title is decided by what it is, never by whether it sits
        in <code>packages/design-system</code>, <code>packages/app</code> or{" "}
        <code>apps/desktop</code>. The one exception: the Electron shell
        genuinely renders a family of surfaces with no web equivalent, so those
        sit together as their own domain,{" "}
        <code>Composites v1.0/Desktop Shell</code>.
      </p>
    </section>

    <section className="space-y-2">
      <h2 className="font-semibold text-xl tracking-tight">
        Everything in one place
      </h2>
      <p className="text-muted-foreground text-sm">
        <code>Start Here/Catalog</code> lists every cataloged component —
        story-backed, catalog-only, and internal — generated straight from the
        filesystem by <code>catalog:sync</code>. If a title in the sidebar
        doesn't match what's in the catalog, <code>validate:catalog</code> fails
        the build.
      </p>
    </section>
  </div>
);

const meta = {
  title: "Start Here/Introduction",
  tags: ["stable"],
  component: IntroductionPage,
  // No autodocs: this page already IS the documentation, so an autodocs
  // wrapper would just add a redundant "Docs" tab beside the one real page.
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof IntroductionPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StartHere: Story = { name: "Start Here" };
