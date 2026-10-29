import type { Meta, StoryObj } from "@storybook/react";
import { V2OverviewPage } from "../v2-overview-page";

// Composites: the sections pages are built from, grouped under the page that uses them. The rules are in TAXONOMY.md, "The page tree".

const CompositesOverviewPage = () => (
  <V2OverviewPage
    current="Composites"
    doesNotGoHere={[
      {
        term: "Whole pages",
        description: "a composed page is a Surface. Look in Surfaces.",
      },
      {
        term: "Empty shells and layouts",
        description:
          "the frame a page is built in is a Pattern. Look in Patterns.",
      },
      {
        term: "Single elements",
        description:
          "a button, input or chip is a Primitive. Look in Primitives.",
      },
    ]}
    goesHere={[
      {
        term: "Page sections",
        description:
          "a part of a page with its own job and content, such as the Session Trace Chart on Session Detail.",
      },
      {
        term: "Under the page that uses it",
        description:
          "a section used only on one page sits under that page; a section shared by pages in one area sits under that area.",
      },
      {
        term: "Shared sections",
        description:
          "a section used across the tree sits under Shared, in a group named for the kind of page, such as Shared/Artifact Detail.",
      },
    ]}
    intro="A composite is one section of a page: a panel, a tab body, a rail, a control group. It is built from Primitives and shows real content. Composites is grouped by the same page tree as Surfaces, so you find a section under the page it belongs to."
    title="Page sections"
  />
);

const meta = {
  title: "Composites/Overview",
  tags: ["stable"],
  component: CompositesOverviewPage,
  // No autodocs: this page already IS the documentation.
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof CompositesOverviewPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
