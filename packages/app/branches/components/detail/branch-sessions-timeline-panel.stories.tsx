import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
import { createRef, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  completeSessionsTrace,
  partialSessionsTrace,
  sessionsPanelDetail,
} from "./branch-sessions-panel-fixtures";
import { BRANCH_SESSIONS_EMPTY_TITLE } from "./branch-sessions-panel-states";
import {
  BranchSessionsTimelinePanel,
  type BranchSessionsTimelinePanelProps,
} from "./branch-sessions-timeline-tab";

/**
 * ISS-10793: the Branch Sessions tab's presentational panel -- the existing
 * "Sessions & timeline" view with its data passed in. Fixture data only;
 * the real fetch and session destinations are the Branch adapter's
 * (ISS-10797). `getSessionHref` names each counted Session in the trace
 * heading as a link to it (ISS-12210); omitted, the heading names none.
 *
 * Controls table:
 * | Prop / arg | Control | Why |
 * |---|---|---|
 * | state | select | the host-set states: ready, loading, empty, error, permission |
 * | coverage | inline-radio | story-level: complete vs partial trace fixture |
 * | stateContent | object | the host's error and permission wording, keyed by state |
 * | onRetry | action | handler |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | detail, trace | fixture objects, switched by `coverage` |
 * | scrollElementRef | a ref owned by the host |
 * | getSessionHref | a route builder owned by the host |
 * | onComposerTargetChange, onRenderedSessionsChange, pendingJumpAnchor | comment-rail hooks (ISS-10794) |
 * | loc | preferred LOC metric; not visually consequential here |
 */

type Coverage = "complete" | "partial";
type StoryArgs = Omit<BranchSessionsTimelinePanelProps, "trace"> & {
  coverage: Coverage;
};

const TRACES = {
  complete: completeSessionsTrace,
  partial: partialSessionsTrace,
};

// Story fixture wording: the panel ships none for error/permission.
const STORY_STATE_CONTENT = {
  error: {
    description: "Fixture: the host explains the failure.",
    title: "Fixture: sessions failed to load",
  },
  permission: {
    description: "Fixture: the host explains the missing access.",
    title: "Fixture: no access to these sessions",
  },
};

const NARROW = { viewport: { value: "390-844" } };
const DARK = { theme: "dark" };

/** The panel with `coverage` resolved to its trace fixture. */
function BranchSessionsPanelStory({ coverage, ...args }: StoryArgs) {
  return (
    <div className="flex h-[640px] w-full flex-col overflow-hidden bg-background">
      <BranchSessionsTimelinePanel
        {...args}
        trace={{
          data: args.state === "loading" ? undefined : TRACES[coverage],
          isLoading: args.state === "loading",
        }}
      />
    </div>
  );
}

const meta = {
  title:
    "Composites/Artifacts/Branches/Branch Detail/Branch Sessions Timeline Panel",
  component: BranchSessionsPanelStory,
  tags: ["stable", "autodocs"],
  parameters: { layout: "fullscreen", controls: { expanded: true } },
  argTypes: {
    state: {
      control: "select",
      options: ["ready", "loading", "empty", "error", "permission"],
      table: { category: "States" },
    },
    coverage: {
      control: "inline-radio",
      options: ["complete", "partial"],
      table: { category: "States" },
    },
    stateContent: { control: "object", table: { category: "States" } },
    onRetry: { action: "retry", table: { category: "States" } },
    getSessionHref: { control: false, table: { category: "Navigation" } },
    detail: { control: false },
    scrollElementRef: { control: false },
    onComposerTargetChange: { control: false, table: { category: "Comments" } },
    onRenderedSessionsChange: {
      control: false,
      table: { category: "Comments" },
    },
    pendingJumpAnchor: { control: false, table: { category: "Comments" } },
    loc: { control: false },
  },
  args: {
    coverage: "complete",
    detail: sessionsPanelDetail,
    getSessionHref: (sessionId) => `/sessions/${sessionId}`,
    onRetry: fn(),
    scrollElementRef: createRef<HTMLDivElement>(),
    state: "ready",
    stateContent: STORY_STATE_CONTENT,
  },
} satisfies Meta<StoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Production's look today. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Combined session trace", { exact: false })
    ).toHaveTextContent("2 sessions");
    // ISS-12448: the links are collapsed until the count is opened.
    await userEvent.click(
      canvas.getByRole("button", { expanded: false, name: "2 sessions" })
    );
    await expect(
      canvas.getByRole("link", { name: "Fixture: Implement Branch Details" })
    ).toHaveAttribute("href", "/sessions/s1");
  },
};

/** Today's skeleton, in place of the timeline. */
export const Loading: Story = {
  args: { state: "loading" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvasElement.querySelector('[data-slot="skeleton"]')
    ).not.toBeNull();
    await expect(
      canvas.queryByText("Combined session trace", { exact: false })
    ).toBeNull();
  },
};

export const LoadingDark: Story = { ...Loading, globals: DARK };

export const LoadingNarrow: Story = { ...Loading, globals: NARROW };

/** No results: the branch has no sessions. */
export const NoSessions: Story = {
  args: { state: "empty" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(BRANCH_SESSIONS_EMPTY_TITLE)).toBeVisible();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

export const NoSessionsDark: Story = { ...NoSessions, globals: DARK };

export const NoSessionsNarrow: Story = { ...NoSessions, globals: NARROW };

/** Failed retrieval: an alert with Retry, distinct from no results. */
export const FailedRetrieval: Story = {
  args: { state: "error" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      STORY_STATE_CONTENT.error.title
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

export const FailedRetrievalDark: Story = {
  ...FailedRetrieval,
  globals: DARK,
};

export const FailedRetrievalNarrow: Story = {
  ...FailedRetrieval,
  globals: NARROW,
};

export const Permission: Story = {
  args: { state: "permission" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(STORY_STATE_CONTENT.permission.title)
    ).toBeVisible();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

export const PermissionDark: Story = { ...Permission, globals: DARK };

export const PermissionNarrow: Story = { ...Permission, globals: NARROW };

/** Partial retrieval: one session withheld, events truncated; the rest shows. */
export const PartialRetrieval: Story = {
  args: { coverage: "partial" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Combined session trace", { exact: false })
    ).toHaveTextContent("1 of 2 sessions rendered");
  },
};

export const PartialRetrievalDark: Story = {
  ...PartialRetrieval,
  globals: DARK,
};

export const PartialRetrievalNarrow: Story = {
  ...PartialRetrieval,
  globals: NARROW,
};

/**
 * Keyboard: from the start of the panel, one Tab reaches Retry -- nothing
 * before it takes focus -- and Enter activates it.
 */
export const KeyboardRetry: Story = {
  args: { state: "error" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = canvas.getByRole("button", { name: "Retry" });
    (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    await expect(canvasElement.ownerDocument.activeElement).toBe(
      canvasElement.ownerDocument.body
    );
    await userEvent.tab();
    await expect(retry).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const DarkTheme: Story = { globals: DARK };

export const Narrow: Story = { globals: NARROW };

export const NarrowDark: Story = { globals: { ...DARK, ...NARROW } };

export const Wide: Story = {
  globals: { viewport: { value: "1512-900" } },
};

/**
 * The panel in the ISS-10790 shell's Sessions slot with the shell's default
 * behaviour: leaving a tab unmounts it, so returning mounts the timeline
 * afresh. No controls: it composes a fixed shell to show the slot.
 */
export const InShell: Story = {
  parameters: { controls: { disable: true } },
  render: () => <InShellHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const traceHeading = () =>
      canvas.queryByText("Combined session trace", { exact: false });
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await expect(traceHeading()).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(canvas.getByText("Fixture: Details.")).toBeVisible();
    await expect(traceHeading()).toBeNull();
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await expect(canvas.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(traceHeading()).toBeVisible();
    await expect(traceHeading()).toHaveTextContent("2 sessions");
    await expect(canvas.queryByText("Fixture: Details.")).toBeNull();
  },
};

function InShellHarness() {
  const [activeTab, setActiveTab] = useState<ArtifactDetailTab>(
    ArtifactDetailTab.Artifact
  );
  const [scrollElementRef] = useState(() => createRef<HTMLDivElement>());
  return (
    <div className="flex h-[640px] flex-col bg-background">
      <ArtifactDetailShell
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
        panels={{
          artifact: <p className="p-4 text-sm">Fixture: Branch workspace.</p>,
          details: <p className="p-4 text-sm">Fixture: Details.</p>,
          sessions: (
            <BranchSessionsTimelinePanel
              detail={sessionsPanelDetail}
              scrollElementRef={scrollElementRef}
              trace={{ data: completeSessionsTrace, isLoading: false }}
            />
          ),
        }}
        tabs={[
          ArtifactDetailTab.Artifact,
          ArtifactDetailTab.Details,
          ArtifactDetailTab.Sessions,
        ]}
      />
    </div>
  );
}
