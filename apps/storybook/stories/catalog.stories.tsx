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
  (root) => root !== "Catalog"
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
      <header className="space-y-2">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          Canonical Inventory
        </p>
        <h1 className="font-semibold text-3xl tracking-tight">
          Storybook component catalog
        </h1>
        <p className="max-w-3xl text-muted-foreground text-sm">
          This inventory is generated from the filesystem into{" "}
          <code>packages/design-system/storybook/component-catalog.ts</code> so
          the full UI surface stays cataloged under one canonical design-system
          hierarchy.
        </p>
      </header>

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
 * The generated inventory of every component in the design system, showing
 * what has a story, what is catalog only, and what stays internal.
 */
const meta = {
  title: "Catalog/Inventory",
  component: CatalogPage,
  tags: ["autodocs"],
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof CatalogPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
