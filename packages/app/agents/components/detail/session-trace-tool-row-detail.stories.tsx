import type { ToolItem } from "@repo/api/src/types/agent-session-tool-call";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionTraceToolRowDetail } from "./session-trace-tool-row-detail";

/**
 * FEA-3696 (wongk review, PR #4256): the expanded panel for one tool-call row,
 * lifted out of `session-trace.tsx` into its own module in the same change.
 *
 * The TRUTHFUL empty state is the whole point of FEA-3696 — a cloud row whose
 * detail lives only in the archived transcript must never claim the call had
 * none — so each of the state-specific panels is canvassed here. That is what
 * keeps the copy honest when someone edits
 * `toolCallDetailEmptyMessage` later: the four empty panels are visible side by
 * side instead of buried behind a trace fixture.
 */
function buildTool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    label: "Bash",
    detail: "pnpm turbo typecheck",
    err: false,
    ...overrides,
  };
}

/**
 * The expanded detail under a tool-call row in a session trace, showing its
 * command, output and status rather than a general code display.
 */
const meta = {
  title: "Primitives/Content/Session Trace Tool Row Detail",
  component: SessionTraceToolRowDetail,
  tags: ["autodocs"],
  argTypes: {
    /*
     * One prop, and it is the whole state matrix: `detailState` (see
     * `TOOL_CALL_DETAIL_STATES`), `input`/`output` and their truncation flags
     * all live inside it, so the panel is driven by editing the object rather
     * than by a control per field.
     */
    tool: { control: "object" },
  },
  parameters: { layout: "padded" },
  args: {
    tool: buildTool({
      input: "pnpm turbo typecheck --filter=api...",
      output: "Tasks:    39 successful, 39 total\nCached:    38 cached",
      durationMs: 4200,
      status: "exit 0",
    }),
  },
} satisfies Meta<typeof SessionTraceToolRowDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Everything hydrated: command, output, and the meta row (status · duration). */
export const Full: Story = {};

/** A call with only a command — no output panel, no meta row. */
export const CommandOnly: Story = {
  args: { tool: buildTool({ input: "git status --porcelain" }) },
};

/** A call with only output, e.g. a tool whose input was not captured. */
export const OutputOnly: Story = {
  args: {
    tool: buildTool({ output: "3 files changed, 47 insertions(+)" }),
  },
};

/**
 * FEA-3547: input and output clipped at `TRACE_TOOL_*_MAX_CHARS`. The `…
 * (truncated)` affordance is appended INSIDE the code block so a reader can see
 * the text is a prefix rather than the whole call.
 */
export const Truncated: Story = {
  args: {
    tool: buildTool({
      input: "rg --json 'lastAgentSessionSyncAttemptAt' packages apps",
      inputTruncated: true,
      output: "packages/api/src/types/agent-session.ts:855:  lastAgent",
      outputTruncated: true,
      detailState: "truncated",
    }),
  },
};

/** Detail existed but was sanitized for policy before it reached the response. */
export const Redacted: Story = {
  args: { tool: buildTool({ detailState: "redacted" }) },
};

/**
 * The cloud list/trace path: no detail was hydrated into THIS response, but it
 * may still exist in the archived transcript. The panel says exactly that
 * instead of claiming the call had no detail.
 */
export const Unavailable: Story = {
  args: { tool: buildTool({ detailState: "unavailable" }) },
};

/** Detail was present on the source event but could not be parsed. */
export const Malformed: Story = {
  args: { tool: buildTool({ detailState: "malformed" }) },
};

/**
 * The producer-bug fallback: a row that claims `available` yet carries nothing
 * displayable. It renders the `unavailable` copy rather than a blank panel, so
 * the UI is never silently empty.
 */
export const AvailableButEmptyFallback: Story = {
  args: { tool: buildTool({ detailState: "available" }) },
};
