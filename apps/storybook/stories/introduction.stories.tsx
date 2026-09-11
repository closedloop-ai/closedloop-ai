import type { Meta, StoryObj } from "@storybook/react";

const IntroductionPage = () => {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 p-6">
      <header className="max-w-3xl space-y-4">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          Start here
        </p>
        <h1 className="font-semibold text-3xl tracking-tight">
          The ClosedLoop design system
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Every piece of interface the product is built from, in one place. Use
          it to find a component before building one, to see how something
          behaves in a state you cannot easily reproduce in the app, and to
          check that what you are about to build matches what already ships.
        </p>
      </header>

      <section className="max-w-3xl space-y-4">
        <h2 className="font-semibold text-xl tracking-tight">
          How this is organised
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Four levels, smallest to largest. A component sits at a level because
          of what it IS, never because of where its code lives.
        </p>
        <dl className="space-y-3 text-sm">
          <LevelRow
            name="Foundations"
            what="The design tokens themselves: colour, type, spacing, radius, motion. Values are read live from the running theme, so they cannot drift from the stylesheet."
          />
          <LevelRow
            name="Primitives"
            what="One cohesive element. A button, an input, a badge. Grouped by what kind of thing it is rather than by feature."
          />
          <LevelRow
            name="Composites"
            what="Built from primitives. Grouped by the product area that owns them, or by element kind when nothing does."
          />
          <LevelRow
            name="Surfaces"
            what="A whole page or a full region of one, assembled from composites. These mount the real product components, so they cannot drift from what ships."
          />
        </dl>
      </section>

      <section className="max-w-3xl space-y-4">
        <h2 className="font-semibold text-xl tracking-tight">How to use it</h2>
        <dl className="space-y-3 text-sm">
          <LevelRow
            name="Read the one-liner"
            what="Every component opens with a single sentence saying what it is and, where it matters, why you would pick it over the one next to it. That is the fastest way to choose between several things that look alike."
          />
          <LevelRow
            name="Poke at the Controls"
            what="The Controls panel below a story drives the component's real props. Change them to see a state without hunting for the data that produces it in the app."
          />
          <LevelRow
            name="Open the Docs tab"
            what="Every component has one. It carries the description, a rendered example and the full table of props with their allowed values."
          />
          <LevelRow
            name="Check the states"
            what="Most components have more than a happy path. Loading, empty, failed and signed out are usually their own stories, named for what they show."
          />
        </dl>
      </section>

      <section className="max-w-3xl space-y-4">
        <h2 className="font-semibold text-xl tracking-tight">
          Where to go next
        </h2>
        <dl className="space-y-3 text-sm">
          <LevelRow
            name="Catalog"
            what="The page below this one in the sidebar. It lists every entry in the system, generated from the filesystem, with a live preview and a link into each story."
          />
        </dl>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Building something with these components? Read{" "}
          <code>apps/storybook/BUILDING.md</code> first. It covers finding the
          right component and the handful of rules that actually get broken.
          Connecting an AI agent to this catalog is covered in{" "}
          <code>apps/storybook/MCP.md</code>.
        </p>
      </section>
    </div>
  );
};

function LevelRow({ name, what }: Readonly<{ name: string; what: string }>) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="font-semibold">{name}</dt>
      <dd className="text-muted-foreground leading-relaxed">{what}</dd>
    </div>
  );
}

/**
 * The landing page: what this design system is, how it is organised, and how to
 * read a component page once you are on one. The list of what is in the system
 * is the Catalog page next to this one.
 *
 * Deliberately has no `autodocs` tag. A landing page does not want a Docs tab
 * and a story as two separate sidebar entries; it wants to be one page.
 *
 * Its one story is named for the component rather than `Default`, which is the
 * house rule everywhere else (see AGENTS.md). Storybook hoists a lone story
 * whose name matches its component into a single sidebar leaf, so the page is
 * one click instead of a folder you expand to find `Default` inside. Worth the
 * exception on the two pages that are the front door.
 */
const meta = {
  title: "Start Here/Introduction",
  component: IntroductionPage,
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof IntroductionPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Introduction: Story = {};
