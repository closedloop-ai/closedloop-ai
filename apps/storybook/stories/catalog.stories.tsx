import type { StorybookCatalogEntry } from "@repo/design-system/storybook/component-catalog";
import {
  canonicalStorybookLevels,
  hasStory,
  storybookComponentCatalog,
} from "@repo/design-system/storybook/component-catalog";
import type { Meta, StoryObj } from "@storybook/react";

import {
  storybookGroupRank,
  storybookSubgroupRank,
} from "../story-group-order";

const storyBackedEntries = storybookComponentCatalog.filter(hasStory);
const catalogOnlyEntries = storybookComponentCatalog.filter(
  (entry) => entry.storyStatus === "catalog-only" && !entry.internal
);
const internalEntries = storybookComponentCatalog.filter(
  (entry) => entry.internal
);
const CatalogPage = () => (
  <div className="mx-auto flex max-w-7xl flex-col gap-8 p-6">
    <header className="space-y-2">
      <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
        Canonical Inventory
      </p>
      <h1 className="font-semibold text-3xl tracking-tight">
        Storybook component catalog
      </h1>
      <p className="max-w-3xl text-muted-foreground text-sm">
        Every entry below is generated from the filesystem into{" "}
        <code>packages/design-system/storybook/component-catalog.ts</code> by{" "}
        <code>catalog:sync</code>, classified into Foundations, Primitives,
        Composites or Surfaces per the rules in{" "}
        <code>apps/storybook/TAXONOMY.md</code> — see{" "}
        <code>Start Here/Introduction</code> for what each level means.
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

          {groupEntriesByTopLevel(sectionName, sectionEntries).map(
            ([groupName, groupEntries]) => (
              <div className="space-y-4" key={groupName || "(no subgroup)"}>
                {groupName ? (
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-semibold text-lg tracking-tight">
                      {groupName}
                    </h3>
                    <span className="rounded-full bg-muted px-3 py-1 font-medium text-muted-foreground text-xs">
                      {groupEntries.length} entries
                    </span>
                  </div>
                ) : null}

                {groupEntriesBySubgroup(
                  sectionName,
                  groupName,
                  groupEntries
                ).map(([subgroupName, subgroupEntries]) => (
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
                      {subgroupEntries.map((entry) => {
                        let status = "Story-backed";
                        if (entry.internal) {
                          status = "Internal helper";
                        } else if (entry.storyStatus === "catalog-only") {
                          status = "Catalog only";
                        }

                        return (
                          <article
                            className="rounded-lg border bg-card p-4 shadow-sm"
                            key={entry.storyTitle}
                          >
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-3">
                                <h5 className="font-medium">{entry.label}</h5>
                                <span className="rounded-full border px-2 py-0.5 font-medium text-[11px] uppercase tracking-wide">
                                  {status}
                                </span>
                              </div>
                              <p className="text-muted-foreground text-xs">
                                <code>{entry.storyTitle}</code>
                              </p>
                              <p className="text-muted-foreground text-xs">
                                <code>{entry.sourcePath}</code>
                              </p>
                              {entry.note ? (
                                <p className="text-muted-foreground text-xs">
                                  {entry.note}
                                </p>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </section>
      )
    )}
  </div>
);

function groupEntriesBySection(entries: readonly StorybookCatalogEntry[]) {
  return Array.from(
    entries.reduce((groups, entry) => {
      const items = groups.get(entry.level) ?? [];
      items.push(entry);
      groups.set(entry.level, items);
      return groups;
    }, new Map<string, StorybookCatalogEntry[]>())
  ).sort(
    ([leftName], [rightName]) =>
      canonicalStorybookLevels.indexOf(
        leftName as (typeof canonicalStorybookLevels)[number]
      ) -
      canonicalStorybookLevels.indexOf(
        rightName as (typeof canonicalStorybookLevels)[number]
      )
  );
}

// Sorted by the SAME declaration the sidebar reads (../story-group-order.ts),
// not by the generated arrays' incidental order — otherwise this page put
// Charts before Inputs and Documents before Agents while the sidebar taught
// the opposite (PR #7280 review, whitlockk).
function groupEntriesByTopLevel(
  level: string,
  entries: readonly StorybookCatalogEntry[]
) {
  return Array.from(
    entries.reduce((groups, entry) => {
      // An empty string, not a fallback label like "Ungrouped": an entry
      // promoted straight to its level with no subgroup (e.g.
      // "Surfaces/Agent Detail") genuinely has no second tier, the same way
      // groupEntriesBySubgroup's own subgroupName can be "". The render
      // below treats an empty groupName the same way it already treats an
      // empty subgroupName — no heading, not a fake bucket.
      const topLevelGroup = entry.pathSegments[0] ?? "";
      const items = groups.get(topLevelGroup) ?? [];
      items.push(entry);
      groups.set(topLevelGroup, items);
      return groups;
    }, new Map<string, StorybookCatalogEntry[]>())
  ).sort(([leftName], [rightName]) => {
    const rankDelta =
      storybookGroupRank(level, leftName) -
      storybookGroupRank(level, rightName);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return leftName.localeCompare(rightName);
  });
}

function groupEntriesBySubgroup(
  level: string,
  groupName: string,
  entries: readonly StorybookCatalogEntry[]
) {
  return Array.from(
    entries.reduce((groups, entry) => {
      const subgroupName = entry.pathSegments.slice(1).join(" / ");
      const items = groups.get(subgroupName) ?? [];
      items.push(entry);
      groups.set(subgroupName, items);
      return groups;
    }, new Map<string, StorybookCatalogEntry[]>())
  ).sort(([leftName], [rightName]) => {
    const rankDelta =
      storybookSubgroupRank(level, groupName, leftName) -
      storybookSubgroupRank(level, groupName, rightName);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return leftName.localeCompare(rightName);
  });
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

const meta = {
  title: "Start Here/Catalog",
  tags: ["stable"],
  component: CatalogPage,
  // No autodocs: this page already IS the documentation, so an autodocs
  // wrapper would just add a redundant "Docs" tab beside the one real page.
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof CatalogPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CatalogIndex: Story = { name: "Catalog Index" };
