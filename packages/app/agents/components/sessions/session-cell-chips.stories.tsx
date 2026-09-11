import type { Meta, StoryObj } from "@storybook/react";
import {
  SessionAutonomyChip,
  SessionHarnessChip,
  SessionModelChip,
} from "./session-cell-chips";

/**
 * ISS-6005: the Harness / Model / Autonomy column treatments, isolated — the
 * prototype-specified pills (`apps/prototypes/app/p/sessions/components/
 * session-cells.tsx`), on production's Radix tooltip mechanism.
 *
 * The matrix IS the point: every autonomy tier (the calibrated High / Mixed /
 * Guided vocabulary the filter facet shares), every known harness, and one
 * model per provider family (Anthropic blue-primary dot, OpenAI green,
 * Google blue-info, unknown muted), side by side in one canvas so tone pairing
 * holds in both themes and a future change cannot quietly de-pill one cell
 * while its neighbours keep the treatment.
 */
const meta: Meta = {
  title: "Composites/Sessions/Listing/Session Cell Chips",
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj;

/** Neutral outlined pills — name only, no icon, no tint (prototype spec). */
export const HarnessPills: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <SessionHarnessChip harness="claude" />
      <SessionHarnessChip harness="codex" />
      <SessionHarnessChip harness="cursor" />
      <SessionHarnessChip harness="copilot" />
      <SessionHarnessChip harness="opencode" />
      {/* Unknown harness degrades to the raw string, still a neutral pill. */}
      <SessionHarnessChip harness="some-new-harness" />
    </div>
  ),
};

/**
 * One model per provider family: the dot is the redundant provider enhancer
 * (the id text carries the information — WCAG 1.4.1), and the tooltip reads
 * `<provider> · <model>` on hover AND keyboard focus.
 */
export const ModelPills: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <SessionModelChip model="claude-opus-4-8" />
      <SessionModelChip model="claude-sonnet-5" />
      <SessionModelChip model="claude-fable-5" />
      <SessionModelChip model="gpt-5.5" />
      <SessionModelChip model="gpt-5-codex" />
      <SessionModelChip model="gemini-3-pro" />
      <SessionModelChip model="unknown-model-2026" />
    </div>
  ),
};

/**
 * All three scored tiers. The numeric score renders NOWHERE in the cell — it is
 * tooltip-only (`Autonomy score N of 100`), which is the prototype's call. A
 * null score never reaches this component (the table renders the shared empty
 * glyph first).
 */
export const AutonomyPills: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <SessionAutonomyChip autonomy={84} />
      <SessionAutonomyChip autonomy={50} />
      <SessionAutonomyChip autonomy={12} />
    </div>
  ),
};

/**
 * The three columns as a row reads them together — the crowding/tone pairing
 * view: harness pill (neutral), model pill (outline + dot), autonomy pill
 * (toned). Status keeps the traffic-light palette to itself; only Autonomy
 * borrows tone, exactly as the prototype specifies.
 *
 * Every row here is a pairing worth JUDGING, not the safe one. `text-success`
 * is both the OpenAI dot and the High-autonomy pill and the Active status badge,
 * so the OpenAI + High row is the case where one green reads as three unrelated
 * things — put it on screen rather than leaving it to be discovered in
 * production. The Google + Mixed row does the same for blue, and the last row
 * pairs the unattributed model with the quietest tier so the all-muted end of
 * the range is visible too.
 */
export const RowPairing: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SessionHarnessChip harness="claude" />
        <SessionModelChip model="claude-opus-4-8" />
        <SessionAutonomyChip autonomy={84} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SessionHarnessChip harness="codex" />
        <SessionModelChip model="gpt-5.5" />
        <SessionAutonomyChip autonomy={92} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SessionHarnessChip harness="cursor" />
        <SessionModelChip model="gemini-3-pro" />
        <SessionAutonomyChip autonomy={50} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SessionHarnessChip harness="a-very-long-unrecognized-harness-id" />
        <SessionModelChip model="unknown-model-2026" />
        <SessionAutonomyChip autonomy={12} />
      </div>
    </div>
  ),
};
