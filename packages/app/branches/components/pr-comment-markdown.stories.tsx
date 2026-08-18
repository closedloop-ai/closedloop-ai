import type { Meta, StoryObj } from "@storybook/react";
import { PrDescriptionMarkdown } from "./pr-comment-markdown";

/** GitHub PR-description structure and untrusted-link/image safety matrix. */
const meta = {
  title: "App Core/Branches/PR Description Markdown",
  component: PrDescriptionMarkdown,
  tags: ["autodocs"],
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
