import { StatusRing } from "@repo/design-system/components/ui/status-icon-primitives";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

/**
 * Renders a circular SVG icon representing numeric completion (0-100%).
 * At 100% it becomes a filled green circle with a check mark. Supports
 * a "thinking" spinner overlay for AI/agent processing.
 */
const meta = {
  title: "Design System/Data Display/Status Percentage Icon",
  component: StatusPercentageIcon,
  tags: ["autodocs"],
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
    size: { control: "select", options: [16, 20] },
    thinking: { control: "boolean" },
    label: { control: "text" },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusPercentageIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: 50 },
};

export const Empty: Story = {
  args: { value: 0 },
};

/**
 * Empty population — there is nothing to complete, which is NOT the same as 0%
 * complete. Modelled as `value={null}`: renders a muted dash in the ring's slot
 * instead of a ring, because a ring of any texture claims a denominator this
 * state does not have. `label` is required for this variant - the mark is
 * generic and only the caller knows what the empty population is.
 */
export const EmptyPopulation: Story = {
  args: { value: null, label: "No documents or issues yet" },
};

/**
 * ISS-4812: the three states that share one 16px column in the documents table,
 * side by side at the size they actually ship at.
 *
 * Empty (a project with no documents or issues) has to separate from a real 0%
 * AND from the Backlog ring that sits on the issue rows right below it. The
 * first two are rings and differ only in fill, which is a texture step the eye
 * loses at this size; the dash differs in silhouette, which does not. Check
 * this story in both light and dark before changing the empty mark.
 *
 * The Backlog exemplar is the raw `StatusRing dashed percentage={0}` that
 * `IssueStatusIcon` renders for that status, redrawn here so this design-system
 * story stays free of domain imports.
 */
export const EmptyVsZeroVsBacklog: Story = {
  args: { value: 0 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <SixteenPxSwatch label="empty (dash)">
        <StatusPercentageIcon
          label="No documents or issues yet"
          size={16}
          value={null}
        />
      </SixteenPxSwatch>
      <SixteenPxSwatch label="0% (ring)">
        <StatusPercentageIcon size={16} value={0} />
      </SixteenPxSwatch>
      <SixteenPxSwatch label="Backlog issue (dashed ring)">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Backlog"
          percentage={0}
          size={16}
        />
      </SixteenPxSwatch>
    </div>
  ),
};

/**
 * The same three marks inside a dense row rhythm, which is the read that
 * actually matters - a glyph can separate in isolation and still disappear in a
 * table.
 */
export const EmptyVsZeroVsBacklogInRows: Story = {
  args: { value: 0 },
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 260,
      }}
    >
      <DenseRow name="Closedloop Platform">
        <StatusPercentageIcon
          label="No documents or issues yet"
          size={16}
          value={null}
        />
      </DenseRow>
      <DenseRow name="Agent Monitor">
        <StatusPercentageIcon size={16} value={0} />
      </DenseRow>
      <DenseRow name="Reconcile branch attribution">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Backlog"
          percentage={0}
          size={16}
        />
      </DenseRow>
      <DenseRow name="Split the session detail view">
        <StatusRing
          color="var(--progress-foreground)"
          label="In Progress"
          percentage={48.5}
          size={16}
        />
      </DenseRow>
    </div>
  ),
};

export const Quarter: Story = {
  args: { value: 25 },
};

export const Half: Story = {
  args: { value: 50 },
};

export const ThreeQuarters: Story = {
  args: { value: 75 },
};

export const Full: Story = {
  args: { value: 100 },
};

/** Increments of 25%. */
export const AllIncrements: Story = {
  args: { value: 0 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {[0, 25, 50, 75, 100].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** Fine-grained increments of 10%. */
export const FineGrained: Story = {
  args: { value: 0 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** Thinking spinner at various percentages — inner fill stays visible while outer ring spins. */
export const Thinking: Story = {
  args: { value: 50, thinking: true },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {[0, 25, 50, 75].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon thinking value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** Side-by-side comparison: normal vs thinking at the same percentage. */
export const NormalVsThinking: Story = {
  args: { value: 60 },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {[25, 50, 75].map((pct) => (
        <div
          key={pct}
          style={{ display: "flex", alignItems: "center", gap: 24 }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <StatusPercentageIcon size={20} value={pct} />
            <span style={{ fontSize: 11 }}>{pct}%</span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <StatusPercentageIcon size={20} thinking value={pct} />
            <span style={{ fontSize: 11 }}>{pct}% thinking</span>
          </div>
        </div>
      ))}
    </div>
  ),
};

/**
 * Custom accessible name. When the percentage summarizes a named population,
 * pass `label` so the screen-reader name states the population the number is a
 * percentage of — the icon is a tooltip-only trigger, so this is the only
 * channel for it. The rendered SVG carries this string as its accessible name
 * (inspect the a11y tab); it replaces the default "N% complete".
 */
export const Labeled: Story = {
  args: { value: 49, label: "49% of documents and issues complete" },
};

/** Size 20 variants. */
export const Size20: Story = {
  args: { value: 50, size: 20 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {[0, 25, 50, 75, 100].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon size={20} value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** One 16px mark under its name, for the side-by-side comparison stories. */
function SixteenPxSwatch({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex max-w-28 flex-col items-center gap-2 text-center">
      {children}
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

/** A table-like row: the 16px mark in its column, then the name. */
function DenseRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 border-b px-2 text-sm last:border-b-0">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {children}
      </span>
      <span className="truncate">{name}</span>
    </div>
  );
}
