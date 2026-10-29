import type { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, type Ref, useRef, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { ArtifactDetailShell } from "./artifact-detail-shell";
import {
  ArtifactTab,
  type ArtifactTabFrame,
  type ArtifactTabProps,
} from "./artifact-tab";

/**
 * The Artifact tab (ISS-10791): the shell's `artifact` panel. It owns the
 * canvas framing, the scroll container and the canvas states; the canvas is
 * whatever the type's adapter passes. Every canvas here is story-local
 * fixture content -- real Session/Branch canvases are ISS-10796/10797's.
 *
 * Controls table:
 * | Prop | Control | Why |
 * |---|---|---|
 * | state | select | the five canvas states, visually distinct |
 * | frame | inline-radio | framed card vs flush canvas |
 * | label | text | the region's accessible name, a real string prop |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | canvas | ReactNode supplied by the type adapter |
 * | scrollRef | a ref, exercised by the ScrollToRow story |
 * | stateContent | per-state wording object; the Error story shows it with an action |
 */
const meta = {
  title: "Composites/Shared/Artifact Detail/Artifact Tab",
  component: ArtifactTabStory,
  tags: ["stable", "autodocs"],
  parameters: { layout: "fullscreen", controls: { expanded: true } },
  argTypes: {
    state: {
      control: "select",
      options: ["ready", "loading", "empty", "error", "permission"],
      table: { category: "Lifecycle" },
    },
    frame: {
      control: "inline-radio",
      options: ["framed", "flush"],
      table: { category: "Framing" },
    },
    label: { control: "text", table: { category: "Framing" } },
    canvas: { control: false, table: { category: "Content" } },
    scrollRef: { control: false, table: { category: "Framing" } },
    stateContent: { control: false, table: { category: "Lifecycle" } },
  },
  args: {
    canvas: <DocumentCanvas />,
    frame: "framed",
    label: "Artifact viewer and editor canvas",
    state: "ready",
  },
  decorators: [
    (Story) => (
      <div className="flex h-[36rem] flex-col bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactTabStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("region", { name: "Artifact viewer and editor canvas" })
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Release plan" })
    ).toBeVisible();
  },
};

export const Loading: Story = {
  args: { state: "loading" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Loading artifact"
    );
    await expect(
      canvas.queryByRole("heading", { name: "Release plan" })
    ).not.toBeInTheDocument();
  },
};

export const LoadingDark: Story = { ...Loading, globals: { theme: "dark" } };

export const LoadingNarrow: Story = {
  ...Loading,
  globals: { viewport: { value: "390-844" } },
};

export const Empty: Story = {
  args: { state: "empty" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Nothing to show yet")).toBeVisible();
  },
};

export const EmptyDark: Story = { ...Empty, globals: { theme: "dark" } };

export const EmptyNarrow: Story = {
  ...Empty,
  globals: { viewport: { value: "390-844" } },
};

export const ErrorWithRetry: Story = {
  args: {
    state: "error",
    stateContent: {
      error: {
        action: { icon: RefreshCwIcon, label: "Retry", onSelect: fn() },
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Unable to load artifact"
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.stateContent?.error?.action?.onSelect).toHaveBeenCalled();
  },
};

export const ErrorWithRetryDark: Story = {
  ...ErrorWithRetry,
  globals: { theme: "dark" },
};

export const ErrorWithRetryNarrow: Story = {
  ...ErrorWithRetry,
  globals: { viewport: { value: "390-844" } },
};

/**
 * Distinct from Empty: a lock and the host's own wording, never "nothing
 * here". The wording below is story fixture text; the tab ships none.
 */
export const Permission: Story = {
  args: {
    state: "permission",
    stateContent: {
      permission: {
        description:
          "Fixture: the host explains why this viewer cannot see it.",
        title: "Fixture permission title",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Fixture permission title")).toBeVisible();
    await expect(
      canvas.queryByText("Nothing to show yet")
    ).not.toBeInTheDocument();
  },
};

export const PermissionDark: Story = {
  ...Permission,
  globals: { theme: "dark" },
};

export const PermissionNarrow: Story = {
  ...Permission,
  globals: { viewport: { value: "390-844" } },
};

export const DarkTheme: Story = { globals: { theme: "dark" } };

/** The flush frame: no card, the canvas fills the tab and scrolls itself. */
export const Flush: Story = {
  args: { canvas: <TimelineCanvas />, frame: "flush" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("list", { name: "Timeline" })).toBeVisible();
  },
};

export const FlushDark: Story = { ...Flush, globals: { theme: "dark" } };

export const FlushNarrow: Story = {
  ...Flush,
  globals: { viewport: { value: "390-844" } },
};

export const Narrow: Story = {
  globals: { viewport: { value: "390-844" } },
};

/**
 * ISS-10791 AC 3, canvas 1 of 2: the Document canvas, framed. Canvas 2 of 2
 * is `CanvasTimeline`. Both stories mount the same shell and the same
 * Artifact tab through `ShellWith`; only the canvas passed in differs, so no
 * shell code changes between them.
 *
 * No controls: it mounts one fixed shell to prove the slot, not a prop.
 */
export const CanvasDocument: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellWith canvas={<DocumentCanvas />} frame="framed" />,
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Artifact viewer and editor canvas",
    });
    await expect(region).toHaveAttribute("data-artifact-frame", "framed");
    await expect(
      within(region).getByRole("heading", { name: "Release plan" })
    ).toBeVisible();
  },
};

export const CanvasDocumentDark: Story = {
  ...CanvasDocument,
  globals: { theme: "dark" },
};

export const CanvasDocumentNarrow: Story = {
  ...CanvasDocument,
  globals: { viewport: { value: "390-844" } },
};

/**
 * ISS-10791 AC 3, canvas 2 of 2: the Timeline canvas, flush. Canvas 1 of 2
 * is `CanvasDocument`; same shell, same Artifact tab, different canvas.
 *
 * No controls: it mounts one fixed shell to prove the slot, not a prop.
 */
export const CanvasTimeline: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellWith canvas={<TimelineCanvas />} frame="flush" />,
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Artifact viewer and editor canvas",
    });
    await expect(region).toHaveAttribute("data-artifact-frame", "flush");
    await expect(
      within(region).getByRole("list", { name: "Timeline" })
    ).toBeVisible();
  },
};

export const CanvasTimelineDark: Story = {
  ...CanvasTimeline,
  globals: { theme: "dark" },
};

export const CanvasTimelineNarrow: Story = {
  ...CanvasTimeline,
  globals: { viewport: { value: "390-844" } },
};

/**
 * Header actions shown while the Artifact tab is active come from the
 * adapter, not the tab: the host passes them to the shell's `headerActions`,
 * which shows them on Artifact only by default (ISS-10790). The button is
 * story fixture content; real actions are ISS-10796/10797's.
 *
 * No controls: it drives one fixed interaction the play function asserts.
 */
export const HeaderActions: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <ShellWith
      canvas={<DocumentCanvas />}
      frame="framed"
      headerActions={
        <Button size="sm" variant="outline">
          <RefreshCwIcon aria-hidden="true" />
          Fixture: adapter action
        </Button>
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const action = { name: "Fixture: adapter action" };
    await expect(canvas.getByRole("button", action)).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(canvas.queryByRole("button", action)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("tab", { name: "Artifact" }));
    await expect(canvas.getByRole("button", action)).toBeVisible();
  },
};

/**
 * The framed tab exposes its scroll container, so a canvas that leaves
 * scrolling to the tab can still bring a row into view (jump to row).
 *
 * No controls: it drives one fixed interaction the play function asserts.
 */
export const ScrollToRow: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ScrollToRowHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Jump to row 40" })
    );
    // The canvas found row 40 through the tab's scroll container. The
    // scroll itself needs real layout, so the story sweep (jsdom) checks the
    // ref reached the container; the browser shows the jump.
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Scrolled to row 40"
    );
  },
};

function ShellWith({
  canvas,
  frame,
  headerActions,
}: {
  canvas: ReactNode;
  frame: "framed" | "flush";
  headerActions?: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<ArtifactDetailTab>("artifact");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactDetailShell
        activeTab={activeTab}
        headerActions={headerActions}
        onActiveTabChange={setActiveTab}
        panels={{
          artifact:
            frame === "flush" ? (
              <ArtifactTab canvas={canvas} frame="flush" />
            ) : (
              <ArtifactTab canvas={canvas} frame="framed" />
            ),
          details: <p className="p-4 text-sm">Details fixture content.</p>,
        }}
        tabs={["artifact", "details"]}
      />
    </div>
  );
}

function ScrollToRowHarness() {
  const scrollRef = useRef<HTMLElement>(null);
  const [jumpedTo, setJumpedTo] = useState<number | null>(null);
  const rows = Array.from({ length: 60 }, (_, index) => index + 1);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-2">
        <button
          className="rounded border px-2 py-1 text-sm"
          onClick={() => {
            const container = scrollRef.current;
            const row =
              container?.querySelector<HTMLElement>('[data-row="40"]');
            if (container && row) {
              // The card is the row's offsetParent (it is `relative`).
              container.scrollTop = row.offsetTop;
              setJumpedTo(40);
            }
          }}
          type="button"
        >
          Jump to row 40
        </button>
        <span className="ml-2 text-muted-foreground text-sm" role="status">
          {jumpedTo === null ? "" : `Scrolled to row ${jumpedTo}`}
        </span>
      </div>
      <ArtifactTab
        canvas={
          <ol className="divide-y text-sm">
            {rows.map((row) => (
              <li className="px-4 py-2" data-row={row} key={row}>
                {`Trace row ${row}`}
              </li>
            ))}
          </ol>
        }
        scrollRef={scrollRef}
      />
    </div>
  );
}

function DocumentCanvas() {
  return (
    <article className="space-y-3 p-6 text-sm">
      <h2 className="font-semibold text-base">Release plan</h2>
      <p className="text-muted-foreground">
        Fixture: canvas 1 of 2, Document. The Artifact tab frames it without
        knowing it is a document.
      </p>
    </article>
  );
}

function TimelineCanvas() {
  const events = [
    "Session started",
    "Plan drafted",
    "Tests passed",
    "PR opened",
  ];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <p className="mb-3 text-muted-foreground text-sm">
        Fixture: canvas 2 of 2, Timeline. It fills the tab and scrolls itself.
      </p>
      <ol aria-label="Timeline" className="space-y-2 text-sm">
        {events.map((event) => (
          <li className="rounded border px-3 py-2" key={event}>
            {event}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * `ArtifactTabProps` is discriminated on `frame`, and CSF cannot build one args
 * type (or one controls table) from a union -- it infers `never`. The stories
 * drive the tab through this flat wrapper and narrow on `frame`, which is the
 * same discrimination the component's own props enforce (ISS-10791 review).
 */
type ArtifactTabStoryArgs = Omit<ArtifactTabProps, "frame" | "scrollRef"> & {
  frame?: ArtifactTabFrame;
  scrollRef?: Ref<HTMLElement>;
};

function ArtifactTabStory({
  frame = "framed",
  scrollRef,
  ...rest
}: ArtifactTabStoryArgs) {
  if (frame === "flush") {
    return <ArtifactTab {...rest} frame="flush" />;
  }
  return <ArtifactTab {...rest} frame="framed" scrollRef={scrollRef} />;
}
