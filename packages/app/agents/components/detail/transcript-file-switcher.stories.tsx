import type { SyncedAgentSessionAgent } from "@repo/api/src/types/agent-session";
import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
} from "@repo/api/src/types/desktop-transcripts";
import type { Meta, StoryObj } from "@storybook/react";
import { withTranscriptFileParam } from "../../lib/session-transcript-href";
import { TranscriptFileSwitcher } from "./transcript-file-switcher";

const SESSION_HREF = "/sessions/session-1";

function file(
  fileKey: string,
  availability: TranscriptAvailability = TranscriptAvailability.Available
): TranscriptAvailabilitySummary {
  return {
    fileKey,
    availability,
    uploadedAt: "2026-08-01T12:00:00.000Z",
    permanentFailureReason: null,
  };
}

function sidechains(count: number): TranscriptAvailabilitySummary[] {
  return Array.from({ length: count }, (_unused, index) =>
    file(`subagent:agent-${index + 1}`)
  );
}

const SUBAGENT_TYPES = [
  "code-reviewer",
  "test-engineer",
  "explorer",
  "design-critic",
  "database-architect",
  "api-architect",
  "security-privacy",
  "devops-architect",
  "typescript-expert",
];

function agents(count: number): SyncedAgentSessionAgent[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        externalAgentId: `agent-${index + 1}`,
        name: SUBAGENT_TYPES[index % SUBAGENT_TYPES.length],
        status: "completed",
        type: "subagent",
        parentExternalAgentId: "agent-main",
        subagentType: SUBAGENT_TYPES[index % SUBAGENT_TYPES.length],
      }) as SyncedAgentSessionAgent
  );
}

/**
 * The LIVE session-detail transcript switcher (ISS-4677). It has a real matrix
 * of visual states — collapsed vs expanded, the pinned active file, the
 * reconciliation caption in both directions, and the muted/warning/unreachable
 * chip treatments — and every one of them is painful to reach by driving the
 * real session detail and cheap to hold still on a canvas.
 *
 * ISS-5366 retired the `sessions-subagent-transcript-disclosure` gate, so the
 * disclosure is the switcher's only rendering and no story seeds a flag.
 */
const meta = {
  title: "App Core/Agents/Detail/Transcript File Switcher",
  component: TranscriptFileSwitcher,
  tags: ["autodocs"],
  argTypes: {
    activeFileKey: {
      control: "text",
      description: "The transcript being rendered: main, or subagent:{id}.",
    },
    files: {
      control: "object",
      description:
        "Per-file availability. Undefined means the producer reported none, and the switcher renders nothing rather than a confident zero.",
    },
    subagentCount: {
      control: { type: "number", min: 0, step: 1 },
      description:
        "The count the Subagents metric card shows, or null when the agent rows have not arrived.",
    },
    agents: {
      control: "object",
      description:
        "Session agent rows, used only to give a sidechain chip a readable name instead of a raw id.",
    },
    buildHref: {
      control: false,
      description:
        "Omitted on a surface without routing, which hides the switcher.",
      table: { category: "Routing" },
    },
  },
  parameters: { layout: "padded" },
  args: {
    activeFileKey: "main",
    buildHref: (fileKey: string) =>
      withTranscriptFileParam(SESSION_HREF, fileKey),
  },
} satisfies Meta<typeof TranscriptFileSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The case that motivated the fold: nine sidechains, collapsed by default, with
 * `Main` inline so the reader can always get back. The header count is a count
 * of FILES and reconciles with the Subagents metric, so it may state a bare
 * `(9)` here — the two agree.
 */
export const Collapsed: Story = {
  args: {
    files: [file("main"), ...sidechains(9)],
    subagentCount: 9,
  },
};

/**
 * With the session's agent rows in hand, each chip carries its subagent TYPE
 * instead of an opaque id, and the drawer sorts on that rendered text. Nine
 * numbered pills gave the reader nothing to choose between.
 */
export const NamedSidechains: Story = {
  args: {
    agents: agents(9),
    files: [file("main"), ...sidechains(9)],
    subagentCount: 9,
  },
};

/**
 * Twelve subagents ran; only nine left a readable transcript. A bare `(9)` beside the
 * word "subagent" would contradict the Subagents MetricCard, so the header
 * states both numbers once and drops the parenthetical.
 */
export const CountShortfall: Story = {
  args: {
    files: [file("main"), ...sidechains(9)],
    subagentCount: 12,
  },
};

/**
 * The same contradiction from the other side. The file lane and the agent-row
 * lane drift independently, so the files can OUTNUMBER the reported subagents —
 * and the bare count is dropped here too.
 */
export const CountSurplus: Story = {
  args: {
    files: [file("main"), ...sidechains(9)],
    subagentCount: 3,
  },
};

/**
 * Every unreadable state at once. The still-uploading chip stays calm and
 * openable — its bytes are on the way — while the three that are never coming
 * are warning-toned, marked in visible text, and not links at all. The caption
 * is toned as a caveat rather than rendered in the calmest color we own.
 */
export const UnreadableSidechains: Story = {
  args: {
    files: [
      file("main"),
      ...sidechains(3),
      file("subagent:agent-5", TranscriptAvailability.UploadPending),
      file("subagent:agent-6", TranscriptAvailability.UploadFailed),
      file("subagent:agent-7", TranscriptAvailability.Missing),
      file("subagent:agent-8", TranscriptAvailability.PermanentlyUnavailable),
    ],
    subagentCount: 7,
  },
};

/**
 * Arriving at `?file=subagent:agent-4` with the disclosure shut. Collapsing may
 * hide options; it may never hide where you are, so the active file is pinned
 * inline beside `Main`.
 */
export const DeepLinkedSidechain: Story = {
  args: {
    activeFileKey: "subagent:agent-4",
    files: [file("main"), ...sidechains(9)],
    subagentCount: 9,
  },
};

/**
 * One extra chip is not a wall, so the disclosure never mounts — but the
 * reconciliation still renders, because a metric of 5 against one readable
 * sidechain is exactly as misleading below the fold threshold as above it.
 */
export const SingleSidechainWithShortfall: Story = {
  args: {
    files: [file("main"), ...sidechains(1)],
    subagentCount: 5,
  },
};

/**
 * The producer never reported per-file availability (an older desktop build, or
 * a detail still loading). We know nothing, so we claim nothing — no chips, no
 * confident `0`.
 */
export const AvailabilityUnknown: Story = {
  args: {
    files: undefined,
    subagentCount: null,
  },
};
