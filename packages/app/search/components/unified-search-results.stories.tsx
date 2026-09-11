import { DocumentType } from "@repo/api/src/types/document";
import type { SearchHit } from "@repo/api/src/types/search";
import {
  PHASE_1_SEARCH_ENTITY_TYPES,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { UnifiedSearchResults } from "./unified-search-results";

const results: SearchHit[] = [
  {
    entityType: SearchEntityType.Document,
    entityId: "doc-1",
    entitySubtype: DocumentType.Prd,
    slug: "unified-search",
    title: "Unified search across artifacts",
    snippet: "one ranked list for <b>search</b> across documents and loops",
    rank: 0.92,
    updatedAt: new Date("2026-08-04T09:12:00.000Z"),
    deepLink: "/documents/doc-1",
  },
  {
    entityType: SearchEntityType.Document,
    entityId: "doc-2",
    entitySubtype: DocumentType.Feature,
    slug: "iss-4665-filter-error-state",
    title: "Filter error state reports a stale count",
    snippet: "the strip reported a count for a query that never ran",
    rank: 0.71,
    updatedAt: new Date("2026-08-02T16:40:00.000Z"),
    deepLink: "/documents/doc-2",
  },
  {
    entityType: SearchEntityType.Loop,
    entityId: "loop-1",
    title: "Alpha search rollout loop",
    snippet: "rolling out the <b>search</b> projection to the alpha org",
    rank: 0.44,
    updatedAt: new Date("2026-07-29T11:05:00.000Z"),
    deepLink: "/loops/loop-1",
  },
];

/**
 * The results list for a search across every kind of content in the app at
 * once, with type filters and highlighted snippets, rather than searching
 * within a single type.
 */
const meta = {
  title: "Composites/Data Display/Unified Search Results",
  component: UnifiedSearchResults,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    activeTypes: {
      control: "multi-select",
      options: PHASE_1_SEARCH_ENTITY_TYPES,
      description: "Selected type facets. Empty means all queryable types.",
      table: { category: "State" },
    },
    filterErrorMessage: { control: "text", table: { category: "State" } },
    hideActiveFacetChips: {
      control: "boolean",
      table: { category: "Appearance" },
    },
    hideTypeFacets: { control: "boolean", table: { category: "Appearance" } },
    isError: { control: "boolean", table: { category: "State" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    onRetry: { control: false, table: { category: "Events" } },
    onSelectResult: { control: false, table: { category: "Events" } },
    onToggleType: { control: false, table: { category: "Events" } },
    results: { control: "object", table: { category: "Data" } },
  },
  args: {
    results,
    isLoading: false,
    isError: false,
    activeTypes: [],
    hideActiveFacetChips: false,
    hideTypeFacets: false,
    onToggleType: fn(),
    onRetry: fn(),
    onSelectResult: fn(),
  },
} satisfies Meta<typeof UnifiedSearchResults>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A settled query with hits: the facet strip, then one row per ranked hit. */
export const Default: Story = {};

/** The `/search` page's shape — its query bar owns kind filtering, so the
 * in-list facet strip and the active-facet chips are both suppressed there. */
export const WithoutTypeFacets: Story = {
  args: { hideTypeFacets: true },
};

/** First load: skeleton rows on the result-row rhythm, so the layout does not
 * jump when hits land. The spinner is what assistive tech hears. */
export const Loading: Story = {
  args: { results: [], isLoading: true },
};

/** A settled query that genuinely matched nothing. Contrast with Filter error
 * below: this copy is only honest when the query actually ran. */
export const Empty: Story = {
  args: { results: [] },
};

/** A network/5xx failure: an honest message plus a retry, never a dead spinner. */
export const LoadError: Story = {
  args: { results: [], isError: true },
};

/**
 * A malformed inline filter (the route's 400). The banner is the WHOLE story —
 * no result body underneath (ISS-4665). Before that fix the error was masked
 * into the body, which fell through to Empty and told the user "No results —
 * Nothing matched your query" for a query the server refused to run. Rendered
 * beside Empty here so that regression is visible on sight: these two states
 * must never look the same.
 */
export const FilterError: Story = {
  args: {
    results: [],
    isError: true,
    filterErrorMessage: "Unknown priority value: huge",
  },
};

/** The filter banner still suppresses the body when the caller holds hits — the
 * rows would belong to the PREVIOUS query, so they are not the failed query's
 * to show. Not reachable from the current hook (a rejected query gets a fresh
 * key that never resolves to data), but pinned so retaining hits later cannot
 * silently reintroduce the claim. */
export const FilterErrorWithHeldHits: Story = {
  args: {
    isError: true,
    filterErrorMessage: "Unknown priority value: huge",
  },
};
