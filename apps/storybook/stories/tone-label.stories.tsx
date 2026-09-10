import { Badge } from "@repo/design-system/components/ui/badge";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A plain colored text label — the low-emphasis sibling of `Badge`/`Chip`
 * (FEA-3968). Reserve filled badges for genuinely varying status that benefits
 * from emphasis; render low-variance categorical values (a Command that is
 * "Manual" on every row, a Type that is "Tool" on every row) as a plain colored
 * string. The color comes from the same `variant` vocabulary the badge uses.
 */
const meta = {
  title: "Primitives/Data Display/Tone Label",
  component: ToneLabel,
  tags: ["autodocs"],
  argTypes: {
    children: { control: "text" },
    variant: {
      options: [
        "default",
        "secondary",
        "destructive",
        "error",
        "success",
        "warning",
        "info",
        "accent",
        "ai",
        "muted",
        "neutral",
        "outline",
      ],
      control: { type: "select" },
      description:
        "Tone, drawn from the same variant vocabulary `Badge` and `Chip` use.",
    },
    title: {
      control: "text",
      description:
        "Native title attribute, for a fuller accessible name when the visible text is a short stem.",
    },
    className: { control: false },
  },
  args: {
    children: "Manual",
    variant: "accent",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ToneLabel>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form — a plain colored string, no fill or border.
 */
export const Default: Story = {};

/**
 * Every variant rendered as a plain label, next to the matching filled `Badge`,
 * so the SSOT color relationship is visible: the label is the badge's text
 * color with the fill and border dropped.
 */
export const LabelVsBadge: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(
        [
          "accent",
          "info",
          "success",
          "warning",
          "muted",
          "error",
          "outline",
        ] as const
      ).map((variant) => (
        <div className="flex items-center gap-4" key={variant}>
          <ToneLabel variant={variant}>{variant}</ToneLabel>
          <Badge variant={variant}>{variant}</Badge>
        </div>
      ))}
    </div>
  ),
};
