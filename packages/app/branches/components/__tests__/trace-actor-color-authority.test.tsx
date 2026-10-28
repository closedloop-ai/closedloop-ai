import type { TurnActor, TurnItem } from "@repo/api/src/types/agent-session";
import type { BasicUser } from "@repo/api/src/types/user";
import { ActorTurnSide } from "@repo/app/shared/lib/actor-color-domain";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../../../agents/components/detail/agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../../../agents/components/detail/session-transcript-panel";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import {
  buildSessionTimeline,
  type TimelineSegment,
} from "../../lib/branch-session-buckets";
import { buildTimelineLegend } from "../branch-pr-activity-timeline-helpers";
import { buildTimelineHumanActorDomain } from "../branch-timeline-human-domain";
import { BranchTraceActorAvatar } from "../branch-trace-actor-avatar";

/**
 * ISS-8772 — one actor, one token, across BOTH traces.
 *
 * Expectations are written out here rather than imported from the authority the
 * traces read: a parity fixture that asks the mapping what it says can never
 * catch the mapping changing.
 *
 * The Branch cases assert PAINTED values. The single-session cases assert the
 * projection contract — that trace does not paint an actor colour today, so
 * `TurnActor.color` is the field the two traces have to agree on, and asserting
 * a rendered swatch there would mean inventing UI this ticket does not ask for.
 */
const ADA_HUMAN_TOKEN =
  "color-mix(in oklch, var(--chart-2) 62%, var(--background))";
const UNKNOWN_HUMAN_TOKEN =
  "color-mix(in oklch, var(--muted-foreground) 70%, var(--card))";

const SESSION_ID = "session-actor-color";
const ADA = "Ada";
const BO = "Bo";

const capturedTraceItems: TurnItem[][] = [];

vi.mock("../../../agents/components/detail/session-trace", () => ({
  SessionTrace: ({ items }: { items: readonly TurnItem[] }) => {
    capturedTraceItems.push([...items]);
    return <div data-testid="session-trace-stub" />;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("actor colour authority across both traces", () => {
  it("resolves the same human actor to the same token in the multi-session stacks and its legend, with a shared-colour avatar", () => {
    const detail = branchDetailWithOneHuman();
    const domain = buildTimelineHumanActorDomain(detail);

    const timeline = buildSessionTimeline(detail, domain);
    const segments = timeline.columns.flatMap(
      (column) => column.segments as readonly TimelineSegment[]
    );
    const adaSegment = segments.find((segment) => segment.label === ADA);
    const legendEntry = buildTimelineLegend(timeline.columns).find(
      (entry) => entry.label === ADA
    );

    render(<BranchTraceActorAvatar actor={adaActor()} />);
    // The letter sits in its own span; the colours are on the fallback.
    const avatarSwatch = screen
      .getByText("A")
      .closest<HTMLElement>('[data-slot="avatar-fallback"]');
    if (!avatarSwatch) {
      throw new Error("no avatar fallback around the initial");
    }

    expect(adaSegment?.color).toBe(ADA_HUMAN_TOKEN);
    expect(legendEntry?.color).toBe(ADA_HUMAN_TOKEN);
    // The shared avatar colours (Nerys, 2026-10-22): the actor's token stays
    // on the stack and legend above; the avatar no longer carries it.
    expect(avatarSwatch).toHaveClass("bg-avatar-placeholder");
    expect(avatarSwatch.style.background).toBe("");
    expect(avatarSwatch.style.color).toBe("");
  });

  it("resolves that same human actor to the same token on the single-session trace", async () => {
    capturedTraceItems.length = 0;
    renderTranscriptPanel({ user: adaUser() });

    const promptActor = await waitFor(() => {
      const actor = firstPromptActor();
      expect(actor).toBeDefined();
      return actor;
    });

    // Not "each equals the constant" — the two traces are compared to each
    // other, so a change that moved only one of them still fails here.
    const branchDetail = branchDetailWithOneHuman();
    const branchTurnColor = buildTimelineHumanActorDomain(
      branchDetail
    ).colorForTurn(ADA, ActorTurnSide.Human);
    expect(promptActor?.color).toBe(branchTurnColor);
    expect(promptActor?.color).toBe(ADA_HUMAN_TOKEN);
  });

  it("states the single-session domain's own rank for a branch's later actor rather than guessing that branch's", async () => {
    capturedTraceItems.length = 0;
    renderTranscriptPanel({ user: boUser() });

    const promptActor = await waitFor(() => {
      const actor = firstPromptActor();
      expect(actor).toBeDefined();
      return actor;
    });

    // A seat is an ordinal WITHIN a domain. Bo acts second on this branch, so
    // the Branch trace seats Bo behind Ada — but Bo's session-detail page holds
    // no branch, and a session can belong to none or several, so its own
    // one-human domain seats Bo first. Pinning BOTH sides stops a later reader
    // mistaking the one-actor agreement above for universal parity, and fails
    // if either side silently starts inventing the other's rank.
    const branchDomain = buildTimelineHumanActorDomain(
      branchDetailWithTwoHumans()
    );
    expect(branchDomain.colorForTurn(ADA, ActorTurnSide.Human)).toBe(
      ADA_HUMAN_TOKEN
    );
    expect(branchDomain.colorForTurn(BO, ActorTurnSide.Human)).not.toBe(
      ADA_HUMAN_TOKEN
    );
    expect(promptActor?.color).toBe(ADA_HUMAN_TOKEN);
    expect(promptActor?.color).not.toBe(
      branchDomain.colorForTurn(BO, ActorTurnSide.Human)
    );
  });

  it("re-seats the DB-projected trace so a fallback render cannot disagree with a parsed one", async () => {
    capturedTraceItems.length = 0;
    // The server-side projection stamps its own per-user hash. Whichever of the
    // two paths this panel takes for the SAME session must resolve one colour.
    render(
      <AppCoreStoryProviders>
        <SessionTranscriptPanel
          fallbackItems={[projectedPrompt("hsl(210 65% 45%)")]}
          session={createAgentSessionDetailFixture({
            id: SESSION_ID,
            harness: "claude",
            user: adaUser(),
          })}
        />
      </AppCoreStoryProviders>
    );

    const promptActor = await waitFor(() => {
      const actor = firstPromptActor();
      expect(actor).toBeDefined();
      return actor;
    });

    expect(promptActor?.color).toBe(ADA_HUMAN_TOKEN);
  });

  it("degrades an unresolved single-session human to the neutral, not a hue", async () => {
    capturedTraceItems.length = 0;
    renderTranscriptPanel({ user: null });

    const promptActor = await waitFor(() => {
      const actor = firstPromptActor();
      expect(actor).toBeDefined();
      return actor;
    });

    expect(promptActor?.color).toBe(UNKNOWN_HUMAN_TOKEN);
  });

  it("degrades an unattributed multi-session actor to that same neutral", () => {
    const domain = buildTimelineHumanActorDomain(branchDetailWithOneHuman());
    expect(domain.colorForTurn(null, ActorTurnSide.Human)).toBe(
      UNKNOWN_HUMAN_TOKEN
    );
  });

  it("gives a repeated actor one seat and a second actor a different one", () => {
    const detail = makeBranchDetail({
      mergedTrace: [
        promptItem("s1", "2026-06-10T09:00:00.000Z", ADA),
        promptItem("s1", "2026-06-10T09:05:00.000Z", ADA),
        promptItem("s2", "2026-06-10T09:10:00.000Z", BO),
      ],
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          ownerUserId: "user-ada",
          ownerUserName: ADA,
        }),
        makeBranchSession({
          sessionId: "s2",
          ownerUserId: "user-bo",
          ownerUserName: BO,
        }),
      ],
    });
    const domain = buildTimelineHumanActorDomain(detail);

    expect(domain.colorForTurn(ADA, ActorTurnSide.Human)).toBe(ADA_HUMAN_TOKEN);
    expect(domain.colorForTurn(BO, ActorTurnSide.Human)).not.toBe(
      ADA_HUMAN_TOKEN
    );
    expect(domain.colorForTurn(BO, ActorTurnSide.Human)).not.toBe(
      UNKNOWN_HUMAN_TOKEN
    );
  });
});

function firstPromptActor(): TurnActor | undefined {
  for (const items of capturedTraceItems) {
    for (const item of items) {
      if (item.type === "prompt") {
        return item.actor;
      }
    }
  }
  return undefined;
}

function adaActor(): TurnActor {
  return {
    name: ADA,
    sessionId: "s1",
    human: ADA,
    color: "unused-by-the-avatar",
  };
}

function adaUser(): BasicUser {
  return {
    id: "user-ada",
    firstName: ADA,
    lastName: null,
    email: "ada@example.test",
    avatarUrl: null,
  };
}

function boUser(): BasicUser {
  return {
    id: "user-bo",
    firstName: BO,
    lastName: null,
    email: "bo@example.test",
    avatarUrl: null,
  };
}

function promptItem(sessionId: string, t: string, actorName: string | null) {
  return {
    actorName,
    cumCostUsd: 1,
    sessionId,
    t,
    text: "Steering",
    tMs: Date.parse(t),
    type: "prompt" as const,
  };
}

function branchDetailWithOneHuman() {
  return makeBranchDetail({
    mergedTrace: [promptItem("s1", "2026-06-10T09:00:00.000Z", ADA)],
    sessions: [
      makeBranchSession({
        sessionId: "s1",
        startedAt: "2026-06-10T09:00:00.000Z",
        endedAt: "2026-06-10T10:00:00.000Z",
        estimatedCostUsd: 4,
        ownerUserId: "user-ada",
        ownerUserName: ADA,
        isPrimary: true,
      }),
    ],
  });
}

const TRANSCRIPT_BODY = `${JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/project",
  message: { role: "user", content: "hello" },
})}\n`;

function renderTranscriptPanel(overrides: { user: BasicUser | null }) {
  const signedUrl = "https://s3.invalid/session/main.jsonl";
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      String(url) === signedUrl
        ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
        : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
  const routes: FixtureRoute[] = [
    {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({
        sessionId: SESSION_ID,
        files: [
          {
            fileKey: "main",
            availability: "available",
            url: signedUrl,
            byteSize: TRANSCRIPT_BODY.length,
            rawSha256: "b".repeat(64),
            uploadedAt: "2026-07-09T12:05:00.000Z",
            lastObservedAt: "2026-07-09T12:05:00.000Z",
            permanentFailureReason: null,
          },
        ],
      }),
    },
  ];
  return render(
    <AppCoreStoryProviders apiRoutes={routes}>
      <SessionTranscriptPanel
        session={createAgentSessionDetailFixture({
          id: SESSION_ID,
          harness: "claude",
          user: overrides.user,
          userColor: "hsl(210 65% 45%)",
          transcripts: [
            {
              fileKey: "main",
              availability: "available",
              uploadedAt: "2026-07-09T12:05:00.000Z",
              permanentFailureReason: null,
            },
          ],
        })}
      />
    </AppCoreStoryProviders>
  );
}

function branchDetailWithTwoHumans() {
  return makeBranchDetail({
    mergedTrace: [
      promptItem("s1", "2026-06-10T09:00:00.000Z", ADA),
      promptItem("s2", "2026-06-10T09:10:00.000Z", BO),
    ],
    sessions: [
      makeBranchSession({
        sessionId: "s1",
        startedAt: "2026-06-10T09:00:00.000Z",
        endedAt: "2026-06-10T10:00:00.000Z",
        estimatedCostUsd: 4,
        ownerUserId: "user-ada",
        ownerUserName: ADA,
        isPrimary: true,
      }),
      makeBranchSession({
        sessionId: "s2",
        startedAt: "2026-06-10T09:10:00.000Z",
        endedAt: "2026-06-10T10:10:00.000Z",
        estimatedCostUsd: 2,
        ownerUserId: "user-bo",
        ownerUserName: BO,
      }),
    ],
  });
}

function projectedPrompt(color: string): TurnItem {
  return {
    type: "prompt",
    _row: 0,
    t: "2026-07-09T11:00:00.000Z",
    tMs: Date.parse("2026-07-09T11:00:00.000Z"),
    cum: 0,
    actor: { name: ADA, sessionId: SESSION_ID, human: ADA, color },
    text: "Steering",
  };
}
