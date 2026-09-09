import {
  FilledStatusCircle,
  StatusDash,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

/**
 * Generic, domain-agnostic building blocks for status icons. `StatusRing`
 * renders a percentage-complete arc + inner pie; `FilledStatusCircle` renders a
 * solid circle with a centered white glyph; `StatusDash` renders the muted dash
 * for a population with nothing to measure. Domain status-icon components
 * compose these to render their own status vocabularies.
 */
const meta = {
  title: "Design System/Primitives/Status Icon Primitives",
  component: StatusRing,
  tags: ["autodocs"],
  argTypes: {
    percentage: {
      control: { type: "range", min: 0, max: 100, step: 0.5 },
      description: "Fill amount. 0 renders an empty or dashed track.",
    },
    color: {
      control: "text",
      description:
        'Arc and inner pie color. Usually a token, e.g. "var(--progress-foreground)".',
    },
    trackColor: {
      control: "text",
      description: "Background circle color. Defaults to var(--progress).",
    },
    label: {
      control: "text",
      description: "Accessible name for the icon.",
    },
    dashed: {
      control: "boolean",
      description: "Dashed track, the backlog look.",
    },
    thinking: {
      control: "boolean",
      description:
        "Replaces the progress arc with a spinner while keeping the inner pie visible.",
    },
    size: {
      options: [16, 20],
      control: { type: "radio" },
    },
    ringStrokeWidth: {
      control: { type: "number", min: 0.5, max: 6, step: 0.5 },
      description: "Track and arc stroke width. Defaults to 2.",
    },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusRing>;

export default meta;
type Story = StoryObj<typeof meta>;

function Swatch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      {children}
      <span style={{ fontSize: 11 }}>{label}</span>
    </div>
  );
}

/** StatusRing at the standard percentage stops. */
export const Ring: Story = {
  args: { percentage: 50, color: "var(--progress-foreground)", label: "Ring" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="empty">
        <StatusRing
          color="var(--progress-foreground)"
          label="Empty"
          percentage={0}
        />
      </Swatch>
      <Swatch label="dashed">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Dashed"
          percentage={0}
        />
      </Swatch>
      <Swatch label="25%">
        <StatusRing
          color="var(--progress-foreground)"
          label="25%"
          percentage={25}
        />
      </Swatch>
      <Swatch label="50%">
        <StatusRing
          color="var(--progress-foreground)"
          label="50%"
          percentage={48.5}
        />
      </Swatch>
      <Swatch label="75%">
        <StatusRing
          color="var(--progress-foreground)"
          label="75%"
          percentage={73.5}
        />
      </Swatch>
      <Swatch label="100%">
        <StatusRing
          color="var(--progress-foreground)"
          label="100%"
          percentage={100}
        />
      </Swatch>
      <Swatch label="thinking">
        <StatusRing
          color="var(--progress-foreground)"
          label="Thinking"
          percentage={48.5}
          thinking
        />
      </Swatch>
    </div>
  ),
};

/** FilledStatusCircle for each glyph. */
export const Filled: Story = {
  args: {
    percentage: 100,
    color: "var(--progress-foreground)",
    label: "Filled",
  },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="check">
        <FilledStatusCircle fill="var(--success)" glyph="check" label="Check" />
      </Swatch>
      <Swatch label="x">
        <FilledStatusCircle fill="var(--foreground)" glyph="x" label="X" />
      </Swatch>
      <Swatch label="swap">
        <FilledStatusCircle fill="var(--ai)" glyph="swap" label="Swap" />
      </Swatch>
      <Swatch label="exclamation">
        <FilledStatusCircle
          fill="var(--warning)"
          glyph="exclamation"
          label="Exclamation"
        />
      </Swatch>
    </div>
  ),
};

/**
 * `StatusDash` - the mark for a population with nothing to measure (a zero
 * denominator), which is not the same as a real zero. It sits in a ring's slot
 * at the same box size, so a row keeps its geometry, and it separates from
 * every ring by silhouette rather than by fill, which is what survives 16px.
 */
export const Dash: Story = {
  args: { percentage: 0, color: "var(--progress-foreground)", label: "Dash" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="16px">
        <StatusDash label="Nothing to measure" size={16} />
      </Swatch>
      <Swatch label="20px">
        <StatusDash label="Nothing to measure" size={20} />
      </Swatch>
      <Swatch label="vs empty ring">
        <StatusRing
          color="var(--progress-foreground)"
          label="Empty ring"
          percentage={0}
          size={16}
        />
      </Swatch>
      <Swatch label="vs dashed ring">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Dashed ring"
          percentage={0}
          size={16}
        />
      </Swatch>
    </div>
  ),
};
