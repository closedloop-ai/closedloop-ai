import {
  compareMonoIds,
  MonoIdCell,
} from "@repo/design-system/components/ui/mono-id-cell";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Composites v1.0/Data Display/Mono ID Cell",
  component: MonoIdCell,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    label: "Version",
    value: "v1.10",
  },
} satisfies Meta<typeof MonoIdCell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const States: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid grid-cols-[10rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Version</span>
      <MonoIdCell label="Version" value="v1.10" />
      <span>Commit</span>
      <MonoIdCell label="Commit" value="4f2a1c9" />
      <span>Build</span>
      <MonoIdCell label="Build" value="build-284" />
      <span>None</span>
      <MonoIdCell label="Version" value={null} />
      <span>Interactive</span>
      <MonoIdCell label="Version" onSelect={() => undefined} value="v1.10" />
    </div>
  ),
};

/**
 * A clipped `4f2a1c9d8b3e...` is not a shorter identifier, it is a different
 * one — so a truncated value keeps the whole string recoverable on hover, and
 * `alignEnd` sinks it under a right-aligned column.
 */
export const Truncation: Story = {
  render: () => (
    <div className="flex w-48 flex-col gap-2 rounded-md border p-3">
      <MonoIdCell
        label="Commit"
        value="4f2a1c9d8b3e77a05619c4f0e2d18b6a3c9f5e21"
      />
      <MonoIdCell alignEnd label="Version" value="v1.10" />
      <MonoIdCell alignEnd label="Version" value="v10.0" />
      <MonoIdCell alignEnd label="Version" value={null} />
    </div>
  ),
};

/**
 * `compareMonoIds` orders by segment: digit runs compare numerically, text runs
 * lexically. The comparator this replaced stripped every non-digit, reading
 * `v1.10` as `110` and `v1.9` as `19` — so the column it sorted disagreed with
 * the column it rendered. `v1.9` before `v1.10` before `v2.0` is the whole
 * proof.
 */
export const Sorting: Story = {
  render: () => {
    const versions = ["v1.10", "v2.0", "v1.9", "v10.0"];
    return (
      <div className="flex flex-col gap-2 text-sm">
        <SortRow label="Unsorted" values={versions} />
        <SortRow
          label="Ascending"
          values={[...versions].sort((a, b) => compareMonoIds(a, b))}
        />
        <SortRow
          label="Descending"
          values={[...versions].sort((a, b) => compareMonoIds(a, b, "desc"))}
        />
      </div>
    );
  },
};

function SortRow({
  label,
  values,
}: Readonly<{ label: string; values: string[] }>) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-24 text-muted-foreground">{label}</span>
      {values.map((value) => (
        <MonoIdCell key={`${label}-${value}`} label="Version" value={value} />
      ))}
    </div>
  );
}
