import type { Meta, StoryObj } from "@storybook/react";
import { PrDescriptionMarkdown } from "./pr-comment-markdown";

/**
 * Renders a GitHub pull request's description as formatted text: headings,
 * links, and images. Use it specifically for the PR description rather than
 * a review comment, since it renders images as plain links and demotes
 * headings so a PR's own formatting never competes visually with the page
 * around it. Raw HTML in the text stays inert, links using javascript: or
 * data: are dropped, and every image, even one written as a raw HTML tag,
 * shows as a plain external link instead of loading a picture, so nothing in
 * an untrusted description can run code or quietly fetch content.
 */
const meta = {
  title: "Composites/Branches/PR Description Markdown",
  component: PrDescriptionMarkdown,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
    text: {
      control: "text",
      description:
        "Untrusted PR body. Raw HTML stays inert, `javascript:` and `data:` sources are dropped, and images render as external links.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] p-4 text-[13px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PrDescriptionMarkdown>;

export default meta;

type Story = StoryObj<typeof meta>;

export const HeadingDepthAndSafeActions: Story = {
  args: {
    text: `# Delivery summary

## Validation

### Residual risk

[Open the pull request](https://github.com/octo/repo/pull/42)

![Architecture diagram](https://example.com/architecture.png)

<img src="https://example.com/pasted-screenshot.png" alt="Pasted screenshot">`,
  },
};

export const UnsafeActionsAndHiddenAutomation: Story = {
  args: {
    text: `## Safety fallbacks

[Unsafe link](javascript:alert('blocked'))

![Inline data image](data:image/png;base64,blocked)

<img src="data:image/png;base64,blocked" alt="Raw inline image">

<!-- goal-orchestrator-workflow
work_item: ISS-4783
-->`,
  },
};
