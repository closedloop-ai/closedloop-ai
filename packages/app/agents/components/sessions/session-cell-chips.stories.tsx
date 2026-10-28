import type { Meta, StoryObj } from "@storybook/react";
import { AutonomyChip, HarnessChip, ModelChip } from "./session-cell-chips";

/**
 * ISS-6005: the Harness / Model / Autonomy column treatments, isolated — the
 * prototype-specified pills (`packages/app/agents/components/sessions/web-master-legacy-preview/components/
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
  title: "Composites v1.0/Sessions/Session Cell Chips",
  tags: ["deprecated"],
};

export default meta;

type Story = StoryObj;

/** Neutral outlined pills — name only, no icon, no tint (prototype spec). */
export const HarnessPills: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <HarnessChip harness="claude" />
      <HarnessChip harness="codex" />
      <HarnessChip harness="cursor" />
      <HarnessChip harness="copilot" />
      <HarnessChip harness="opencode" />
      {/* Unknown harness degrades to the raw string, still a neutral pill. */}
      <HarnessChip harness="some-new-harness" />
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
      <ModelChip model="claude-opus-4-8" />
      <ModelChip model="claude-sonnet-5" />
      <ModelChip model="claude-fable-5" />
      <ModelChip model="gpt-5.5" />
      <ModelChip model="gpt-5-codex" />
      <ModelChip model="gemini-3-pro" />
      <ModelChip model="unknown-model-2026" />
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
      <AutonomyChip autonomy={84} />
      <AutonomyChip autonomy={50} />
      <AutonomyChip autonomy={12} />
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
        <HarnessChip harness="claude" />
        <ModelChip model="claude-opus-4-8" />
        <AutonomyChip autonomy={84} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <HarnessChip harness="codex" />
        <ModelChip model="gpt-5.5" />
        <AutonomyChip autonomy={92} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <HarnessChip harness="cursor" />
        <ModelChip model="gemini-3-pro" />
        <AutonomyChip autonomy={50} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <HarnessChip harness="a-very-long-unrecognized-harness-id" />
        <ModelChip model="unknown-model-2026" />
        <AutonomyChip autonomy={12} />
      </div>
    </div>
  ),
};
