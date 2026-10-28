import type { Meta, StoryObj } from "@storybook/react";
import { V2OverviewPage } from "../v2-overview-page";

// Surfaces: the finished pages, built from one pattern and composites. The rules are in TAXONOMY.md, "The page tree".

const SurfacesOverviewPage = () => (
  <V2OverviewPage
    current="Surfaces"
    doesNotGoHere={[
      {
        term: "Sections on their own",
        description: "a part of a page is a Composite. Look in Composites.",
      },
      {
        term: "Layouts without content",
        description:
          "a page's frame with empty regions is a Pattern. Look in Patterns.",
      },
    ]}
    goesHere={[
      {
        term: "Finished pages",
        description:
          "the live app's own page component, in the Composites Global Nav frame and fed with fixture data, so it has every element the live page has.",
      },
      {
        term: "Page states",
        description:
          "each state the live page reaches, as a story: its tabs, empty, loading and error states.",
      },
      {
        term: "The page tree",
        description:
          "every page has its place here; its pattern and sections sit at the same path in their roots.",
      },
    ]}
    intro="A surface is a whole page as a user sees it. Surfaces defines the page tree, in the live app's sidebar order and then the pages outside it. Composites and Patterns follow the same tree."
    title="Finished pages"
  />
);

const meta = {
  title: "Surfaces/Overview",
  tags: ["stable"],
  component: SurfacesOverviewPage,
  // No autodocs: this page already IS the documentation.
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof SurfacesOverviewPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
