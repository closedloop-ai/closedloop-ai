import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { SearchSurfaceV2PageDemo } from "./search-surface-v2-page-demo";
import { SEARCH_DEMO_HITS } from "./search-surface-v2-page-demo-fixtures";

const RE_COUNT_STRIP = /results for/;
// The canonical parser's own wire message (the search route 400s with
// `parsed.errors[0].message`), deliberately re-typed rather than imported: a
// fixture built from our own constant would agree with our own mistake.
const RE_PARSER_FILTER_ERROR = /Unknown status value: huge/;

/**
 * The prototype route's one allowlisted surface. Mounted here with the same
 * mock-only memory navigation adapter `PrototypeShell` gives it on
 * `/p/search-results`, so what Storybook renders is what the design review
 * gets held against.
 */
const meta = {
  component: SearchSurfaceV2PageDemo,
  decorators: [
    (Story) => (
      <NavigationProvider
        adapter={
          createMemoryNavigation({ initialPath: "/search", orgSlug: "acme" })
            .adapter
        }
      >
        <div className="p-6">
          <Story />
        </div>
      </NavigationProvider>
    ),
  ],
  parameters: { layout: "fullscreen" },
  title: "Composites v1.0/Search/Search Surface V2 Page Demo",
  tags: ["deprecated"],
} satisfies Meta<typeof SearchSurfaceV2PageDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The landing state: the seeded query committed, every fixture hit matching. */
export const Default: Story = {};

/**
 * The count strip is the shared `SearchResultCountStrip`, so the demo says the
 * same honest `N results for "<query>"` the shipped page does — and never a
 * total it cannot compute.
 */
export const CountStripMatchesProduction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const strip = await canvas.findByText(RE_COUNT_STRIP, { selector: "p" });
    await expect(strip).toHaveTextContent(
      `${SEARCH_DEMO_HITS.length} results for`
    );
  },
};

/**
 * A committed query that matches nothing lands No results rather than showing
 * the fixture corpus as if it had matched (#7344 review).
 */
export const QueryThatMatchesNothing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Search query");
    await userEvent.clear(input);
    await userEvent.type(input, "zzzz{Enter}");
    await expect(
      await canvas.findByText(RE_COUNT_STRIP, { selector: "p" })
    ).toHaveTextContent('0 results for "zzzz"');
  },
};

/**
 * A malformed filter token reports the canonical parser's own message — the
 * same sentence the search route 400s with.
 */
export const MalformedFilterToken: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Search query");
    await userEvent.clear(input);
    await userEvent.type(input, "agent status:huge{Enter}");
    await expect(
      await canvas.findByText(RE_PARSER_FILTER_ERROR)
    ).toBeInTheDocument();
  },
};
