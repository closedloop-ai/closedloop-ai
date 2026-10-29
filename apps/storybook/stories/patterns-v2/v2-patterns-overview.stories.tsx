import type { Meta, StoryObj } from "@storybook/react";
import { V2OverviewPage } from "../v2-overview-page";

// Patterns: page shells and layouts, with no content. The rules are in TAXONOMY.md, "The page tree".

const PatternsOverviewPage = () => (
  <V2OverviewPage
    current="Patterns"
    doesNotGoHere={[
      {
        term: "Content",
        description:
          "every slot is an empty, named region. Content is a Composite; the filled page is a Surface.",
      },
      {
        term: "Single elements",
        description:
          "a button, input or chip is a Primitive. Look in Primitives.",
      },
    ]}
    goesHere={[
      {
        term: "Page shells",
        description:
          "the frame around a page's content, such as the artifact detail shell's header and tabs.",
      },
      {
        term: "Layouts",
        description:
          "how a page's regions are arranged and respond to width, and the page's own rules, such as its tab set and which tabs show the comments rail.",
      },
      {
        term: "At the page's own path",
        description:
          "a page's pattern sits at the same path as the page; a shell used across the tree sits under Shared.",
      },
    ]}
    intro="A pattern is the frame a page is built in: its shell, its regions and how they arrange and respond to width. Every region is empty and named. Every Surfaces page should be traceable to one of the patterns here."
    title="Page shells and layouts"
  />
);

const meta = {
  title: "Patterns/Overview",
  tags: ["stable"],
  component: PatternsOverviewPage,
  // No autodocs: this page already IS the documentation.
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof PatternsOverviewPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
