"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { Input } from "@repo/design-system/components/ui/input";
import {
  CircleDotIcon,
  FlaskConical,
  Search,
  TagIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { type ComponentProps, type ReactNode, useMemo, useState } from "react";
import {
  type PrototypeStatus,
  type PrototypeTag,
  prototypeStatusLabel,
  prototypeStatusOrder,
  prototypeTagLabel,
  prototypeTagOrder,
} from "@/lib/registry";
import { prototypes } from "@/lib/registry.generated";

const statusVariant: Record<
  PrototypeStatus,
  ComponentProps<typeof Badge>["variant"]
> = {
  draft: "outline",
  "in-progress": "info",
  "ready-for-review": "success",
  "handed-off": "muted",
};

type GalleryFilters = {
  authors: string[];
  statuses: PrototypeStatus[];
  tags: PrototypeTag[];
};

const EMPTY_FILTERS: GalleryFilters = {
  authors: [],
  statuses: [],
  tags: [],
};

export const PrototypeGallery = () => {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<GalleryFilters>(EMPTY_FILTERS);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prototypes.filter((prototype) => {
      const matchesQuery =
        needle.length === 0 ||
        prototype.title.toLowerCase().includes(needle) ||
        prototype.summary.toLowerCase().includes(needle) ||
        prototype.author.toLowerCase().includes(needle);
      const matchesAuthors =
        filters.authors.length === 0 ||
        filters.authors.includes(prototype.author);
      const matchesStatuses =
        filters.statuses.length === 0 ||
        filters.statuses.includes(prototype.status);
      const matchesTags =
        filters.tags.length === 0 ||
        filters.tags.some((tag) => prototype.tags.includes(tag));
      return matchesQuery && matchesAuthors && matchesStatuses && matchesTags;
    });
  }, [query, filters]);

  return (
    <>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search prototypes"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prototypes"
            type="search"
            value={query}
          />
        </div>
        {/* Match the trigger height to the h-9 search input; the compound
            selector out-specifies the FilterPopover button's own h-8. */}
        <div className="[&_button]:h-9">
          <FilterPopover
            controller={NOOP_CONTROLLER}
            viewModel={{
              teamMembers: [],
              statusOptions: [],
              priorityOptions: [],
              hideQuickToggles: true,
              facetGroups: galleryFacetGroups(filters, setFilters),
            }}
          />
        </div>
      </div>
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((prototype) => (
            <Link
              className="group"
              href={`/p/${prototype.slug}`}
              key={prototype.slug}
            >
              <Card className="h-full transition-colors group-hover:border-primary/40">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle>{prototype.title}</CardTitle>
                    <Badge variant={statusVariant[prototype.status]}>
                      {prototypeStatusLabel[prototype.status]}
                    </Badge>
                  </div>
                  <CardDescription className="line-clamp-4">
                    {prototype.summary}
                  </CardDescription>
                  {prototype.tags.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {prototype.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {prototypeTagLabel[tag]}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </CardHeader>
                <CardFooter className="text-muted-foreground text-xs">
                  {prototype.author} · {prototype.createdAt}
                </CardFooter>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          description="Try a different search or clear the filters."
          icon={FlaskConical}
          title="No matching prototypes"
        />
      )}
    </>
  );
};

// Structural shape matching FilterPopover's generic `facetGroups` prop. Declared
// locally so the prototype imports only the catalog-listed `filter-popover`
// component; TypeScript checks compatibility structurally.
type FacetGroup = {
  id: string;
  label: string;
  icon?: ReactNode;
  options: { id: string; label: string; count?: number }[];
  selectedValues: string[];
  onToggle: (value: string) => void;
};

// The gallery facet menu drives its own state via `facetGroups`, so the built-in
// assignee/status/priority controller is inert here (mirrors the product's
// NOOP_TABLE_FILTERS_CONTROLLER).
const NOOP = () => undefined;

const NOOP_CONTROLLER = {
  filters: {
    assigneeIds: [],
    assignToMe: false,
    hideCompletedItems: false,
    favoritesOnly: false,
    statuses: [],
    priorities: [],
    date: null,
    tagIds: [],
  },
  toggleAssignee: NOOP,
  toggleAssignToMe: NOOP,
  toggleHideCompletedItems: NOOP,
  toggleFavoritesOnly: NOOP,
  toggleStatus: NOOP,
  togglePriority: NOOP,
  setDateFilter: NOOP,
  toggleTag: NOOP,
  clearCategoryFilter: NOOP,
  clearAllFilters: NOOP,
  activeChips: [],
};

function toggleFacetValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function galleryFacetGroups(
  filters: GalleryFilters,
  onChange: (next: GalleryFilters) => void
): FacetGroup[] {
  const authorCounts = new Map<string, number>();
  const statusCounts = new Map<PrototypeStatus, number>();
  const tagCounts = new Map<PrototypeTag, number>();
  for (const prototype of prototypes) {
    authorCounts.set(
      prototype.author,
      (authorCounts.get(prototype.author) ?? 0) + 1
    );
    statusCounts.set(
      prototype.status,
      (statusCounts.get(prototype.status) ?? 0) + 1
    );
    for (const tag of prototype.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return [
    {
      id: "assignee",
      label: "Assignee",
      icon: <UsersIcon className="size-4" />,
      options: [...authorCounts.keys()].sort().map((author) => ({
        id: author,
        label: author,
        count: authorCounts.get(author) ?? 0,
      })),
      selectedValues: filters.authors,
      onToggle: (value) =>
        onChange({
          ...filters,
          authors: toggleFacetValue(filters.authors, value),
        }),
    },
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: prototypeStatusOrder.map((status) => ({
        id: status,
        label: prototypeStatusLabel[status],
        count: statusCounts.get(status) ?? 0,
      })),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(
            filters.statuses,
            value as PrototypeStatus
          ),
        }),
    },
    {
      id: "type",
      label: "Type",
      icon: <TagIcon className="size-4" />,
      options: prototypeTagOrder.map((tag) => ({
        id: tag,
        label: prototypeTagLabel[tag],
        count: tagCounts.get(tag) ?? 0,
      })),
      selectedValues: filters.tags,
      onToggle: (value) =>
        onChange({
          ...filters,
          tags: toggleFacetValue(filters.tags, value as PrototypeTag),
        }),
    },
  ];
}
