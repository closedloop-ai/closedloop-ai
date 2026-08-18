import { chartColor } from "@repo/design-system/components/ui/chart-colors";
import type { BranchScenario } from "./mock-detail";
import { idleTimelineColumn, timelineColumn } from "./timeline-fixtures";

const ACTOR_COLORS = Array.from({ length: 2 }, (_, index) => chartColor(index));

/** Canonical Inbox branch detail fixture. */
export const INBOX_SCENARIO: BranchScenario = {
  prBody: `Rebuilds the Inbox on the realtime channel so notifications update without a manual refresh.

- Subscribes the list to the Liveblocks presence room, cleaning up on unmount
- Collapses the old poll-every-30s hook; reads are now push-driven
- Adds an unread rollup that survives route transitions

Testing: pnpm --filter app test`,
  costTotal: "$412",
  valuePerDollar: "7.42",
  leadTimeMergedLabel: "3h 06m",
  activeLabel: "2h 18m",
  idleLabel: "48m",
  idlePct: 26,
  waterfall: [
    { type: "build", pct: 30 },
    { type: "idle", pct: 12 },
    { type: "build", pct: 20 },
    { type: "review", pct: 12 },
    { type: "idle", pct: 14 },
    { type: "rework", pct: 12 },
  ],
  costSegments: [
    {
      key: "build",
      label: "Build",
      duration: "1h 35m",
      cost: "$301",
      pct: 73,
      color: "#4f7df0",
    },
    {
      key: "review",
      label: "Review",
      duration: "25m",
      cost: "$78",
      pct: 19,
      color: "#8b5cf6",
    },
    {
      key: "rework",
      label: "Rework",
      duration: "18m",
      cost: "$33",
      pct: 8,
      color: "#c2412d",
    },
  ],
  deliveredArtifacts: [{ slug: "FEA-3512" }],
  files: [
    {
      path: "apps/app/app/(authenticated)/[orgSlug]/inbox/page.tsx",
      additions: 88,
      deletions: 40,
    },
    {
      path: "packages/app/inbox/hooks/use-inbox-realtime.ts",
      additions: 74,
      deletions: 0,
    },
    {
      path: "packages/app/inbox/hooks/use-inbox.ts",
      additions: 26,
      deletions: 4,
    },
  ],
  comments: [
    {
      id: "c1",
      author: "sam-chen",
      at: "3h ago",
      path: "packages/app/inbox/hooks/use-inbox-realtime.ts",
      line: 42,
      anchorPreview: "const room = useRoom(roomId);",
      body: "Make sure the subscription tears down on unmount — this room leaks otherwise.",
    },
    {
      id: "c2",
      author: "parker-byrd",
      at: "2h ago",
      body: "Confirmed the cleanup return is in place; unread rollup looks right.",
    },
  ],
  sessions: [
    {
      id: "s1",
      actorId: "u-sam",
      actor: "Sam Chen",
      sub: "inbox-realtime-v2",
      color: ACTOR_COLORS[0],
      activeLabel: "2h 04m",
      startPct: 0,
      endPct: 84,
      bursts: [
        { leftPct: 0, widthPct: 26 },
        { leftPct: 34, widthPct: 30 },
        { leftPct: 70, widthPct: 14 },
      ],
    },
    {
      id: "s2",
      actorId: "u-sam",
      actor: "Sam Chen",
      sub: "wiring + cleanup follow-up",
      color: ACTOR_COLORS[1],
      activeLabel: "44m",
      startPct: 40,
      endPct: 92,
      bursts: [{ leftPct: 40, widthPct: 24 }],
    },
  ],
  trace: [
    {
      id: "t1",
      userId: "u-sam",
      side: "human",
      timeLabel: "1:20pm",
      blocks: [
        {
          type: "p",
          spans: [
            "Rebuild the Inbox on the realtime channel so notifications update without a manual refresh.",
          ],
        },
      ],
    },
    {
      id: "t2",
      userId: "u-sam",
      side: "agent",
      timeLabel: "1:21pm",
      durationLabel: "41m 08s",
      costLabel: "$2.94",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "Subscribed the list to the Liveblocks presence room and collapsed the old ",
            { code: "useInboxPoll" },
            " hook. Reads are now push-driven.",
          ],
        },
        {
          type: "ul",
          items: [
            [
              "The subscription tears down on unmount — the room leaked otherwise (",
              { pr: 1281 },
              " review caught this).",
            ],
            ["Unread rollup survives route transitions."],
          ],
        },
        {
          type: "tools",
          summary: "Ran 4 tools · 4 tool",
          rows: [
            {
              label: "Edit",
              detail: "packages/app/inbox/hooks/use-inbox-realtime.ts",
            },
            { label: "Edit", detail: "apps/app/…/inbox/page.tsx" },
            { label: "Bash", detail: "pnpm --filter app test — all passing" },
            { label: "Bash", detail: "gh pr create --fill" },
          ],
        },
      ],
    },
    {
      id: "t3",
      userId: "u-sam",
      side: "agent",
      timeLabel: "4:20pm",
      durationLabel: "6m 02s",
      costLabel: "$0.71",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "The realtime cleanup and unread-rollup checks are passing on ",
            { pr: 1281 },
            ". The branch is ready for review.",
          ],
        },
      ],
    },
  ],
  timelineColumns: [
    timelineColumn({ input: 1500, output: 9000, cacheRead: 148_100 }, [
      { color: ACTOR_COLORS[0], pct: 100 },
    ]),
    timelineColumn({ input: 2500, output: 13_600, cacheRead: 240_100 }, [
      { color: ACTOR_COLORS[0], pct: 55 },
      { color: ACTOR_COLORS[1], pct: 45 },
    ]),
    idleTimelineColumn(),
    timelineColumn({ input: 2000, output: 11_200, cacheRead: 200_300 }, [
      { color: ACTOR_COLORS[1], pct: 60 },
      { color: ACTOR_COLORS[0], pct: 40 },
    ]),
    timelineColumn({ input: 1100, output: 6900, cacheRead: 114_000 }, [
      { color: ACTOR_COLORS[0], pct: 100 },
    ]),
  ],
  startLabel: "13:20",
  endLabel: "16:26",
  eventDots: [
    {
      leftPct: 8,
      kind: "blue",
      label: "Rebuild Inbox on the realtime channel",
      at: "13:20",
      targetTurnId: "t1",
    },
    {
      leftPct: 38,
      kind: "green",
      label: "First commit",
      at: "14:02",
      targetTurnId: "t2",
    },
    {
      leftPct: 88,
      kind: "green",
      label: "CI passing",
      at: "16:20",
      targetTurnId: "t3",
    },
  ],
};
