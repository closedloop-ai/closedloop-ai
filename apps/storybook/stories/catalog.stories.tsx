import type { StorybookCatalogEntry } from "@repo/design-system/storybook/component-catalog";
import {
  canonicalStorybookRoots,
  hasStory,
  storybookComponentCatalog,
} from "@repo/design-system/storybook/component-catalog";
import type { Meta, StoryObj } from "@storybook/react";
import {
  OpenStoryLink,
  StoryPreview,
  useStoryIdsByTitle,
} from "./catalog-preview";

const sectionOrder = canonicalStorybookRoots.filter(
  (root) => root !== "Start Here"
);

const storyBackedEntries = storybookComponentCatalog.filter(hasStory);
const catalogOnlyEntries = storybookComponentCatalog.filter(
  (entry) => entry.storyStatus === "catalog-only" && !entry.internal
);
const internalEntries = storybookComponentCatalog.filter(
  (entry) => entry.internal
);
const CatalogPage = () => {
  // Title -> story id, resolved from the running Storybook so every card
  // links and previews the real story rather than a guessed id.
  const storyIdsByTitle = useStoryIdsByTitle();

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
        <p className="text-muted-foreground text-sm leading-relaxed">
          Building something with these components? Read{" "}
          <code>apps/storybook/BUILDING.md</code> first. It covers finding the
          right component and the handful of rules that actually get broken.
          Connecting an AI agent to this catalog is covered in{" "}
          <code>apps/storybook/MCP.md</code>.
        </p>
      </section>

      <section className="max-w-3xl space-y-2">
        <h2 className="font-semibold text-xl tracking-tight">
          Everything in it
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Generated from the filesystem into{" "}
          <code>packages/design-system/storybook/component-catalog.ts</code>, so
          this list cannot fall behind what exists.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard
          label="Story-backed entries"
          value={storyBackedEntries.length}
        />
        <StatCard
          label="Catalog-only entries"
          value={catalogOnlyEntries.length}
        />
        <StatCard label="Internal helpers" value={internalEntries.length} />
        <StatCard
          label="Total catalog entries"
          value={storybookComponentCatalog.length}
        />
      </section>

      {groupEntriesBySection(storybookComponentCatalog).map(
        ([sectionName, sectionEntries]) => (
          <section className="space-y-6" key={sectionName}>
            <div className="space-y-1">
              <h2 className="font-semibold text-2xl tracking-tight">
                {sectionName}
              </h2>
              <p className="text-muted-foreground text-sm">
                {sectionEntries.length} total entries
              </p>
            </div>

            {groupEntriesByTopLevel(sectionEntries).map(
              ([groupName, groupEntries]) => (
                <div className="space-y-4" key={groupName}>
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-semibold text-lg tracking-tight">
                      {groupName}
                    </h3>
                    <span className="rounded-full bg-muted px-3 py-1 font-medium text-muted-foreground text-xs">
                      {groupEntries.length} entries
                    </span>
                  </div>

                  {groupEntriesBySubgroup(groupEntries).map(
                    ([subgroupName, subgroupEntries]) => (
                      <div
                        className="space-y-3"
                        key={`${groupName}-${subgroupName}`}
                      >
                        {subgroupName ? (
                          <h4 className="font-medium text-sm uppercase tracking-wide">
                            {subgroupName}
                          </h4>
                        ) : null}

                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {subgroupEntries.map((entry) => (
                            <CatalogEntryCard
                              entry={entry}
                              key={entry.storyTitle}
                              storyId={storyIdsByTitle?.[entry.storyTitle]}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </div>
              )
            )}
          </section>
        )
      )}
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

function groupEntriesBySection(entries: readonly StorybookCatalogEntry[]) {
  return Array.from(
    entries.reduce((groups, entry) => {
      const items = groups.get(entry.section) ?? [];
      items.push(entry);
      groups.set(entry.section, items);
      return groups;
    }, new Map<string, StorybookCatalogEntry[]>())
  ).sort(
    ([leftName], [rightName]) =>
      sectionOrder.indexOf(leftName as (typeof sectionOrder)[number]) -
      sectionOrder.indexOf(rightName as (typeof sectionOrder)[number])
  );
}

function groupEntriesByTopLevel(entries: readonly StorybookCatalogEntry[]) {
  return Array.from(
    entries.reduce((groups, entry) => {
      const topLevelGroup = entry.pathSegments[0] ?? "Ungrouped";
      const items = groups.get(topLevelGroup) ?? [];
      items.push(entry);
      groups.set(topLevelGroup, items);
      return groups;
    }, new Map<string, StorybookCatalogEntry[]>())
  );
}

function groupEntriesBySubgroup(entries: readonly StorybookCatalogEntry[]) {
  return Array.from(
    entries.reduce((groups, entry) => {
      const subgroupName = entry.pathSegments.slice(1).join(" / ");
      const items = groups.get(subgroupName) ?? [];
      items.push(entry);
      groups.set(subgroupName, items);
      return groups;
    }, new Map<string, StorybookCatalogEntry[]>())
  );
}

/**
 * Extracted from the grouping JSX so the page component stays under biome's
 * cognitive-complexity ceiling; the status/previewable branching all lives
 * here now rather than nested four maps deep.
 */
function CatalogEntryCard({
  entry,
  storyId,
}: Readonly<{ entry: StorybookCatalogEntry; storyId: string | undefined }>) {
  let status = "Story-backed";
  if (entry.internal) {
    status = "Internal helper";
  } else if (entry.storyStatus === "catalog-only") {
    status = "Catalog only";
  }

  // Catalog-only rows and internal helpers have no story to mount, so they
  // stay text-only rather than rendering an empty preview frame.
  const isPreviewable = !entry.internal && entry.storyStatus !== "catalog-only";

  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h5 className="font-medium">{entry.label}</h5>
        <span className="shrink-0 rounded-full border px-2 py-0.5 font-medium text-[11px] uppercase tracking-wide">
          {status}
        </span>
      </div>

      {isPreviewable ? (
        <StoryPreview storyId={storyId} title={entry.label} />
      ) : null}

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          <code>{entry.storyTitle}</code>
        </p>
        <p className="text-muted-foreground text-xs">
          <code>{entry.sourcePath}</code>
        </p>
        {entry.note ? (
          <p className="text-muted-foreground text-xs">{entry.note}</p>
        ) : null}
        {isPreviewable ? <OpenStoryLink storyId={storyId} /> : null}
      </div>
    </article>
  );
}

function StatCard({
  label,
  value,
}: Readonly<{ label: string; value: number }>) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="font-semibold text-3xl">{value}</div>
      <p className="text-muted-foreground text-sm">{label}</p>
    </div>
  );
}

/**
 * The landing page: what this design system is, how it is organised, how to use
 * it, and then every component in it.
 *
 * Deliberately has no `autodocs` tag. A landing page does not want a Docs tab
 * and a story as two separate sidebar entries; it wants to be one page.
 */
const meta = {
  title: "Start Here",
  component: CatalogPage,
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof CatalogPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
