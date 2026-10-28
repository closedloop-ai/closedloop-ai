import {
  type AgentComponent,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import type { GridTableColumn } from "@repo/design-system/components/ui/grid-table";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, within } from "storybook/test";
import { KindLabel } from "../../lib/component-meta";
import { AgentCardHeaderAttributes } from "./agent-card-header-attributes";
import { makeComponent } from "./agent-component-fixtures";
import { LocPerDollarColumnValue } from "./loc-per-dollar-cell";

/**
 * ISS-5532 — the state matrix for the Agents card's promoted header attributes.
 *
 * `agents-card-attribute-labels.test.tsx` pins the STRINGS (which term names
 * which value, and that the pair is a real `dt`/`dd`). It cannot pin what this
 * canvas is for: the tone pairing between a term and its value, and whether two
 * labelled groups still read as two groups when the card is only as wide as a
 * phone. Those are geometry, and jsdom does no layout.
 *
 * The component is prop-driven — `AgentsTable` resolves the gate once and passes
 * the answer down, because the card is also the RN adapter's entry point
 * (FEA-3872) — so `labelledAttributes` is just an arg here and both sides of the
 * gate are one control away from each other.
 */

/** The two columns the card promotes, with the LABELS the grid header uses. */
const CARD_COLUMNS: readonly GridTableColumn[] = [
  { id: "type", label: "Type", sortable: true },
  { id: "metric", label: LOC_PER_DOLLAR_LABEL, sortable: true },
];

const TOOL_COMPONENT = makeComponent({
  id: "uuid-iss-5532",
  kind: AgentComponentKind.Tool,
  locPerDollar: 2.5,
  name: "acme/refactor-tool",
  slug: "tool::refactor-tool",
});

/**
 * The card path's real cell output: `KindLabel` for the type chip and the metric
 * value LEFT-aligned, which is how the card renders it (the grid right-aligns so
 * its fixed precision lines the decimals up — `alignEnd` is a grid-only concern).
 * Composed from the production components rather than restated as text, so a
 * change to either chip shows up on this canvas.
 */
function renderCardCell(columnId: string, item: AgentComponent): ReactNode {
  if (columnId === "type") {
    return <KindLabel kind={item.kind} />;
  }
  return <LocPerDollarColumnValue value={item.locPerDollar} />;
}

/**
 * Stands in for the card header's name lead and its column, so the attributes
 * are judged where they actually sit: under a name, inside a `min-w-0` flex
 * column, at a real card's width. Presentational only — the production lead is a
 * link with truncation behavior this canvas is not about.
 */
function CardHeaderFrame({
  children,
  width = "20rem",
}: Readonly<{ children: ReactNode; width?: string }>) {
  return (
    <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex min-w-0 flex-col gap-1.5" style={{ width }}>
        <span className="truncate font-medium text-sm">
          {TOOL_COMPONENT.name}
        </span>
        {children}
      </div>
    </div>
  );
}

const meta = {
  title: "Composites v1.0/Agents/Workspace/Agent Card Header Attributes",
  component: AgentCardHeaderAttributes,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: {
    columns: CARD_COLUMNS,
    item: TOOL_COMPONENT,
    renderCellForItem: renderCardCell,
    showMetric: true,
    showType: true,
  },
  decorators: [
    (Story) => (
      <CardHeaderFrame>
        <Story />
      </CardHeaderFrame>
    ),
  ],
} satisfies Meta<typeof AgentCardHeaderAttributes>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * ISS-5532 ON, both attributes present. Each promoted value carries its own
 * column's term above it — the muted term against the foreground value is the
 * tone pairing this canvas exists to judge.
 */
export const Labelled: Story = {
  args: { labelledAttributes: true },
  play: async ({ canvasElement }) => {
    // The sweep otherwise only proves this MOUNTS, and an unlabelled render
    // mounts just as happily — this is the story's whole subject. Asserted as
    // `term`s rather than as text so it is the `dt`/`dd` pairing (WCAG 1.3.1)
    // under test, which is the thing ISS-5532 actually added.
    const canvas = within(canvasElement);
    const terms = canvas.getAllByRole("term").map((el) => el.textContent);
    await expect(terms).toEqual(["Type", LOC_PER_DOLLAR_LABEL]);
    await expect(canvas.getAllByRole("definition")).toHaveLength(2);
  },
};

/**
 * The pre-ISS-5532 line, and what still ships while the gate is off: a bare Type
 * chip and a hand-built label/value span. Compare against {@link Labelled} —
 * this is the card that opened on an anonymous `Tool`.
 */
export const Unlabelled: Story = {
  args: { labelledAttributes: false },
  play: async ({ canvasElement }) => {
    // Guards the OFF arm specifically: the gate ships closed by default
    // (ISS-4779), so "no term above the type chip" is the contract here, not an
    // absence nobody checked. `Type` is the term the ON arm adds; the metric's
    // own label is present either way, since the OFF branch hand-builds it.
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Type")).toBeNull();
  },
};

/**
 * ISS-5475: the metric is unavailable, so the WHOLE labelled group goes rather
 * than the header reading `LOC / $ —`. A labelled dash says less than nothing
 * here — the card header is not a column that has to hold its place.
 */
export const LabelledWithoutMetric: Story = {
  args: { labelledAttributes: true, showMetric: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const terms = canvas.getAllByRole("term").map((el) => el.textContent);
    // Exactly one group survives, and it is the type's. A second term — or a
    // surviving `LOC / $` anywhere — is the ISS-5475 bug the header must not
    // regress into: a labelled dash instead of a withheld group.
    await expect(terms).toEqual(["Type"]);
    await expect(canvas.queryByText(LOC_PER_DOLLAR_LABEL)).toBeNull();
  },
};

/**
 * Type collapsed out of the grid (FEA-3968 drops a low-variance column), so the
 * card must not promote a value the grid itself dropped. The metric's group
 * stands alone rather than the header keeping an empty slot for the type.
 */
export const LabelledWithoutType: Story = {
  args: { labelledAttributes: true, showType: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Type")).toBeNull();
    // The metric's TERM, not merely its text: the unlabelled branch also prints
    // this string, in a hand-built span. Asserting the `dt` is what makes this
    // story fail if the labelled branch stops rendering — the surviving term is
    // the only thing distinguishing the two arms once the type group is gone.
    const terms = canvas.getAllByRole("term");
    await expect(terms).toHaveLength(1);
    await expect(terms[0]).toHaveTextContent(LOC_PER_DOLLAR_LABEL);
  },
};

/**
 * Both gates side by side at one width — the actual before/after argument for
 * the ticket, and the fastest way to see whether the added terms cost the header
 * more vertical room than the naming is worth.
 */
export const GateComparison: Story = {
  decorators: [],
  parameters: {
    controls: { exclude: ["labelledAttributes"] },
  },
  render: (args) => (
    <div className="flex flex-wrap gap-4">
      <CardHeaderFrame>
        <AgentCardHeaderAttributes {...args} labelledAttributes={false} />
      </CardHeaderFrame>
      <CardHeaderFrame>
        <AgentCardHeaderAttributes {...args} labelledAttributes />
      </CardHeaderFrame>
    </div>
  ),
};

/**
 * The narrow end of the card's range — a small phone, where the two labelled
 * groups have to wrap onto separate lines rather than crowd or clip. This is the
 * geometry the jsdom suite cannot see, and the reason this file exists.
 */
export const NarrowWidth: Story = {
  args: { labelledAttributes: true },
  decorators: [],
  render: (args) => (
    <CardHeaderFrame width="9rem">
      <AgentCardHeaderAttributes {...args} />
    </CardHeaderFrame>
  ),
};

/**
 * A long metric beside the type at the narrow width: four integer digits plus
 * the fixed two decimals is the widest the value gets, and it must still wrap
 * with its own term rather than shoving the type group off the card.
 */
export const NarrowWidthLongMetric: Story = {
  args: {
    labelledAttributes: true,
    item: makeComponent({
      id: "uuid-iss-5532-wide",
      kind: AgentComponentKind.Tool,
      locPerDollar: 1234.5,
      name: "acme/refactor-tool",
    }),
  },
  decorators: [],
  render: (args) => (
    <CardHeaderFrame width="9rem">
      <AgentCardHeaderAttributes {...args} />
    </CardHeaderFrame>
  ),
};
