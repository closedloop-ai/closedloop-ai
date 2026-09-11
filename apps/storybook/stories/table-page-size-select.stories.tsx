import {
  buildTableRangeReadout,
  DEFAULT_TABLE_PAGE_SIZE,
  TABLE_PAGE_SIZE_OPTIONS,
  TablePageSizeSelect,
} from "@repo/design-system/components/ui/table-page-size-select";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

// The rows-per-page control that sits at the left of `TablePaginationFooter`
// (FEA-4199), and the range readout derived beside it.
// It lives in the design system rather than in the Sessions surface that asked
// for it because every list surface already shares that footer — a Sessions-local
// pager would have been the fifth hand-rolled variant of a strip that was
// consolidated precisely to stop those drifting apart.
// The label is the option text ("25 / page") rather than a separate "Rows per
// page" caption: the strip is dense, and the trigger carries the accessible name
// for assistive tech (WCAG 4.1.2).
/**
 * A small dropdown for choosing how many rows show per page in a paginated
 * table, sharing the same 25, 50, 100 ladder every list in the product uses.
 */
const meta = {
  title: "Primitives/Inputs/Table Page Size Select",
  component: TablePageSizeSelect,
  tags: ["autodocs"],
  argTypes: {
    pageSize: {
      control: { type: "number", min: 1, max: 500, step: 1 },
      description: "Rows per page currently selected.",
    },
    options: {
      control: "object",
      description: "Overrides the shared 25/50/100 ladder.",
    },
    onPageSizeChange: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    pageSize: DEFAULT_TABLE_PAGE_SIZE,
    options: TABLE_PAGE_SIZE_OPTIONS,
    onPageSizeChange: fn(),
  },
} satisfies Meta<typeof TablePageSizeSelect>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The shared 25/50/100 ladder, starting on the default every surface shipped. */
export const Default: Story = {
  render: () => {
    const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
    return (
      <div className="flex items-center gap-3">
        <TablePageSizeSelect
          onPageSizeChange={setPageSize}
          pageSize={pageSize}
        />
        <p className="text-muted-foreground text-xs">
          {buildTableRangeReadout({
            noun: "sessions",
            page: 0,
            pageSize,
            total: 240,
          })}
        </p>
      </div>
    );
  },
};

/**
 * A caller may override the ladder — a surface whose rows are expensive to
 * render can offer a shorter one.
 */
export const CustomOptions: Story = {
  render: () => {
    const [pageSize, setPageSize] = useState(10);
    return (
      <TablePageSizeSelect
        onPageSizeChange={setPageSize}
        options={[10, 20]}
        pageSize={pageSize}
      />
    );
  },
};

/**
 * `buildTableRangeReadout`'s edge cases, which are the whole reason the readout
 * is derived in one place instead of formatted per surface.
 *
 * A `null` result is the honest answer, not a bug: the caller renders NO readout
 * rather than "1–0 of 0". The clamped row is what stops a stale `?page=` (or a
 * page size the user just grew) claiming a range past the end of the data.
 */
export const RangeReadoutCases: Story = {
  render: () => (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-muted-foreground text-xs">
          <th className="py-2 pr-4 font-medium">Case</th>
          <th className="py-2 pr-4 font-medium">Input</th>
          <th className="py-2 font-medium">Readout</th>
        </tr>
      </thead>
      <tbody>
        {READOUT_CASES.map((readoutCase) => (
          <tr className="border-b last:border-0" key={readoutCase.label}>
            <td className="py-2 pr-4">{readoutCase.label}</td>
            <td className="py-2 pr-4 font-mono text-muted-foreground text-xs">
              {`page ${readoutCase.page}, size ${readoutCase.pageSize}, total ${readoutCase.total}`}
            </td>
            <td className="py-2">
              {buildTableRangeReadout({ noun: "sessions", ...readoutCase }) ?? (
                <span className="text-muted-foreground italic">
                  null — no readout rendered
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
};

/** Every ladder value against one population, so the strip's density is visible. */
export const EveryLadderSize: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {TABLE_PAGE_SIZE_OPTIONS.map((option) => (
        <p className="text-muted-foreground text-xs" key={option}>
          {buildTableRangeReadout({
            noun: "sessions",
            page: 0,
            pageSize: option,
            total: 12_550,
          })}
        </p>
      ))}
    </div>
  ),
};

const READOUT_CASES = [
  { label: "First page", page: 0, pageSize: 25, total: 240 },
  { label: "Last partial page", page: 9, pageSize: 25, total: 240 },
  {
    label: "Thousands (all three numbers localized)",
    page: 41,
    pageSize: 25,
    total: 12_550,
  },
  { label: "Empty result set", page: 0, pageSize: 25, total: 0 },
  {
    label: "Page index past the end (clamped)",
    page: 99,
    pageSize: 25,
    total: 30,
  },
  { label: "Single row", page: 0, pageSize: 25, total: 1 },
];
