"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";
import { designSystemComponentCatalog } from "@repo/design-system/storybook/component-catalog";
import { SquareMousePointerIcon } from "lucide-react";
import {
  allDesignSystemTokensGroupId,
  primaryTaxonomyGroupForToken,
  type StyleTaxonomyGroup,
  StyleTokenScope,
  styleReconciliationGroupId,
  TokenCategory,
  type TokenDefinition,
  tokensForTaxonomyGroup,
} from "./style-browser-editor-data";

export function StyleCatalogRail({
  groups,
  selectedGroupId,
  tokensById,
  changedTokenIds,
  query,
  catalogPivot,
  onCatalogPivotChange,
  onQueryChange,
  onSelectCatalogItem,
}: {
  groups: readonly StyleTaxonomyGroup[];
  selectedGroupId: string;
  tokensById: Readonly<Record<string, TokenDefinition>>;
  changedTokenIds: ReadonlySet<string>;
  query: string;
  catalogPivot: StyleCatalogPivot;
  onCatalogPivotChange: (pivot: StyleCatalogPivot) => void;
  onQueryChange: (query: string) => void;
  onSelectCatalogItem: (item: StyleCatalogItem) => void;
}) {
  const items = catalogItemsForPivot(catalogPivot, groups, tokensById);
  const visibleItems = items.filter((item) => itemMatchesQuery(item, query));
  return (
    <aside className="min-h-0 overflow-auto border-b bg-background p-3 lg:border-r lg:border-b-0">
      <div className="mb-3 flex items-center gap-2 text-muted-foreground text-xs">
        <SquareMousePointerIcon className="size-3.5" />
        Catalog
      </div>
      <Tabs
        className="gap-3"
        onValueChange={(value) =>
          onCatalogPivotChange(parseStyleCatalogPivot(value))
        }
        value={catalogPivot}
      >
        <TabsList className="grid h-auto w-full grid-cols-2">
          <TabsTrigger value={StyleCatalogPivot.Taxonomy}>Taxonomy</TabsTrigger>
          <TabsTrigger value={StyleCatalogPivot.Category}>Category</TabsTrigger>
          <TabsTrigger value={StyleCatalogPivot.Scope}>Scope</TabsTrigger>
          <TabsTrigger value={StyleCatalogPivot.Source}>Source</TabsTrigger>
        </TabsList>
        <Command className="rounded-md border" shouldFilter={false}>
          <CommandInput
            onValueChange={onQueryChange}
            placeholder="Find style, token, or source..."
            value={query}
          />
          <CommandList className="max-h-none">
            <CommandEmpty>No matching styles.</CommandEmpty>
            <CommandGroup heading={catalogPivotLabel[catalogPivot]}>
              {visibleItems.map((item) => {
                const changedCount = item.tokens.filter((token) =>
                  changedTokenIds.has(token.id)
                ).length;
                return (
                  <CommandItem
                    className={cn(
                      "items-start gap-2",
                      item.groupId === selectedGroupId && "bg-muted"
                    )}
                    key={item.id}
                    onSelect={() => onSelectCatalogItem(item)}
                    value={`${item.label} ${item.description} ${item.searchText}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-sm">
                        {item.label}
                      </span>
                      <span className="mt-0.5 block text-muted-foreground text-xs">
                        {item.description}
                      </span>
                      {changedCount > 0 ? (
                        <span className="mt-1 block text-info text-xs">
                          {changedCount} changed
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {item.count}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </Tabs>
    </aside>
  );
}

export const StyleCatalogPivot = {
  Category: "category",
  Scope: "scope",
  Source: "source",
  Taxonomy: "taxonomy",
} as const;

export type StyleCatalogPivot =
  (typeof StyleCatalogPivot)[keyof typeof StyleCatalogPivot];

export type StyleCatalogItem = {
  id: string;
  label: string;
  description: string;
  count: number;
  groupId: string;
  tokens: readonly TokenDefinition[];
  searchText: string;
};

function itemMatchesQuery(item: StyleCatalogItem, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }
  return `${item.label} ${item.description} ${item.searchText}`
    .toLowerCase()
    .includes(normalizedQuery);
}

function catalogItemsForPivot(
  pivot: StyleCatalogPivot,
  groups: readonly StyleTaxonomyGroup[],
  tokensById: Readonly<Record<string, TokenDefinition>>
): StyleCatalogItem[] {
  if (pivot === StyleCatalogPivot.Category) {
    return Object.values(TokenCategory).map((category) => {
      const tokens = Object.values(tokensById).filter(
        (token) => token.category === category
      );
      return buildCatalogItem({
        count: tokens.length,
        description: categoryDescriptions[category],
        groupId:
          primaryTaxonomyGroupForToken(tokens[0])?.id ??
          allDesignSystemTokensGroupId,
        id: `category:${category}`,
        label: `${categoryLabels[category]} tokens`,
        tokens,
      });
    });
  }
  if (pivot === StyleCatalogPivot.Scope) {
    return Object.values(StyleTokenScope).map((scope) => {
      const tokens = Object.values(tokensById).filter(
        (token) => token.scope === scope
      );
      return buildCatalogItem({
        count: tokens.length,
        description: scopeDescriptions[scope],
        groupId:
          primaryTaxonomyGroupForToken(tokens[0])?.id ??
          allDesignSystemTokensGroupId,
        id: `scope:${scope}`,
        label: scopeLabels[scope],
        tokens,
      });
    });
  }
  if (pivot === StyleCatalogPivot.Source) {
    return [
      buildCatalogItem({
        count: Object.keys(tokensById).length,
        description:
          "Generated from packages/design-system/styles/globals.css.",
        groupId: allDesignSystemTokensGroupId,
        id: "source:design-system-globals",
        label: "Design-system token manifest",
        tokens: Object.values(tokensById),
      }),
      ...designSystemComponentCatalog
        .filter((entry) => !("internal" in entry && entry.internal))
        .map((entry) =>
          buildCatalogItem({
            count: 1,
            description: entry.sourcePath,
            groupId: componentCatalogGroupId(entry.label),
            id: `source:${entry.id}`,
            label: entry.label,
            searchText: `${entry.storyTitle} ${entry.pathSegments.join(" ")}`,
            tokens: [],
          })
        ),
      buildCatalogItem({
        count: 3,
        description:
          "Tag colors and Storybook fixture colors that are visible in app stories but not tokenized yet.",
        groupId: styleReconciliationGroupId,
        id: "source:app-core-tags",
        label: "App Core tag color sources",
        searchText:
          "packages/app/shared/components/tag-color-picker.tsx packages/app/shared/components/tag-chip.tsx apps/storybook/stories/filter-popover.stories.tsx",
        tokens: [],
      }),
      buildCatalogItem({
        count: 2,
        description:
          "Custom-field and generic artifact palettes currently live as Tailwind class maps outside the design-system token manifest.",
        groupId: styleReconciliationGroupId,
        id: "source:custom-field-palettes",
        label: "Custom-field palette sources",
        searchText:
          "packages/app/custom-fields/components/color-picker.tsx packages/design-system/components/ui/table-add-field-dialog.tsx packages/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model.tsx",
        tokens: [],
      }),
      buildCatalogItem({
        count: 1,
        description:
          "Prototype-owned literals, actor palettes, branch colors, and pack tints that should be tokenized or remapped before production.",
        groupId: styleReconciliationGroupId,
        id: "source:prototype-local-overrides",
        label: "Prototype local overrides",
        searchText:
          "apps/prototypes/app/p/agents/component-meta.tsx apps/prototypes/app/p/agents/mock.ts packages/app/branches/components/prototype-preview/mock-detail.ts apps/prototypes app local colors hex className",
        tokens: [],
      }),
      buildCatalogItem({
        count: 2,
        description:
          "Shadcn/Radix component recipes and production heading utilities that are part of the effective style system.",
        groupId: styleReconciliationGroupId,
        id: "source:shadcn-raw-utilities",
        label: "Shadcn and raw utility recipes",
        searchText:
          "packages/design-system/components/ui button badge input popover dialog apps/app heading utilities apps/desktop page-shell typography h1 h2 h3 h4 h5",
        tokens: [],
      }),
    ];
  }
  return groups.map((group) => {
    const tokens = tokensForTaxonomyGroup(group, tokensById);
    return buildCatalogItem({
      count: tokens.length,
      description: group.description,
      groupId: group.id,
      id: `taxonomy:${group.id}`,
      label: group.label,
      tokens,
    });
  });
}

function buildCatalogItem({
  id,
  label,
  description,
  count,
  groupId,
  tokens,
  searchText,
}: {
  id: string;
  label: string;
  description: string;
  count: number;
  groupId: string;
  tokens: readonly TokenDefinition[];
  searchText?: string;
}): StyleCatalogItem {
  return {
    count,
    description,
    groupId,
    id,
    label,
    searchText:
      searchText ??
      tokens
        .map((token) => `${token.label} ${token.cssName} ${token.initialValue}`)
        .join(" "),
    tokens,
  };
}

function parseStyleCatalogPivot(value: string): StyleCatalogPivot {
  if (value === StyleCatalogPivot.Category) {
    return StyleCatalogPivot.Category;
  }
  if (value === StyleCatalogPivot.Scope) {
    return StyleCatalogPivot.Scope;
  }
  if (value === StyleCatalogPivot.Source) {
    return StyleCatalogPivot.Source;
  }
  return StyleCatalogPivot.Taxonomy;
}

function componentCatalogGroupId(label: string): string {
  const normalizedLabel = label.toLowerCase();
  if (normalizedLabel.includes("brand") || normalizedLabel.includes("icon")) {
    return "logos";
  }
  if (normalizedLabel.includes("badge") || normalizedLabel.includes("chip")) {
    return styleReconciliationGroupId;
  }
  return allDesignSystemTokensGroupId;
}

const catalogPivotLabel: Record<StyleCatalogPivot, string> = {
  [StyleCatalogPivot.Category]: "By category",
  [StyleCatalogPivot.Scope]: "By CSS scope",
  [StyleCatalogPivot.Source]: "By source",
  [StyleCatalogPivot.Taxonomy]: "Canonical taxonomy",
};

const categoryLabels: Record<TokenCategory, string> = {
  [TokenCategory.Color]: "Color",
  [TokenCategory.Icon]: "Icon",
  [TokenCategory.Layout]: "Layout",
  [TokenCategory.Shape]: "Shape",
  [TokenCategory.Type]: "Typography",
};

const categoryDescriptions: Record<TokenCategory, string> = {
  [TokenCategory.Color]: "Semantic colors, chart series, surfaces, and assets.",
  [TokenCategory.Icon]: "Icon scale variables and SVG-related sizing.",
  [TokenCategory.Layout]: "Spacing, density, breakpoints, and z-index layers.",
  [TokenCategory.Shape]: "Radius and shadow variables.",
  [TokenCategory.Type]: "Font families, type scale, and weight variables.",
};

const scopeLabels: Record<StyleTokenScope, string> = {
  [StyleTokenScope.Root]: ":root variables",
  [StyleTokenScope.Theme]: "@theme inline variables",
};

const scopeDescriptions: Record<StyleTokenScope, string> = {
  [StyleTokenScope.Root]:
    "Runtime CSS variables consumed directly by components.",
  [StyleTokenScope.Theme]:
    "Tailwind-published variables that become utility-facing design tokens.",
};
