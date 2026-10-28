import type {
  AgentSessionDetail,
  TurnActor,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { BasicUser } from "@repo/api/src/types/user";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { formatTraceCostPrecise } from "@repo/lib/sessions/trace-cost-format";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UNATTRIBUTED_ACTOR_LABEL } from "../../../../branches/lib/branch-actor-domain";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";
import { formatTraceClock } from "../trace-row-utils";

/** One initial on every avatar (Nerys, 2026-10-22), and nothing else. */
const ONLY_A = /^A$/;

/**
 * ISS-12666: the standalone Session trace shows the Branch combined trace's
 * actor avatar in every turn gutter, above the timing it already showed.
 *
 * The photo assertions run over the shared `AvatarImage` stand-in, so they
 * speak to the `<img>` it renders and its `alt` only; the avatar's name is
 * asserted on the real `role="img"` container.
 */
// `vi.mock` hoists above the imports, so the shared factory is loaded inside it.
vi.mock("@repo/design-system/components/ui/avatar", async (importOriginal) => {
  const { avatarImageMockModule } = await import(
    "../../../../test/mocks/avatar-image"
  );
  return avatarImageMockModule(importOriginal);
});

const SESSION_ID = "session-gutter-avatars";
const MODEL = "claude-opus-4-8";
const PHOTO_URL = "https://avatars.invalid/ada.png";
const PROMPT_MS = Date.parse("2026-07-09T11:00:00.000Z");
const REPLY_MS = PROMPT_MS + 5000;
const REPLY_END_MS = REPLY_MS + 90_000;
const REPLY_COST_USD = 0.25;

const ADA: BasicUser = {
  id: "user-ada",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: PHOTO_URL,
};

const agentActor: TurnActor = {
  name: MODEL,
  sessionId: SESSION_ID,
  human: null,
  color: "var(--primary)",
  harness: "claude",
};

function humanActor(name: string): TurnActor {
  return { name, sessionId: SESSION_ID, human: name, color: "#000" };
}

function traceItems(human: TurnActor): TurnItem[] {
  return [
    {
      type: "prompt",
      _row: 0,
      t: new Date(PROMPT_MS).toISOString(),
      tMs: PROMPT_MS,
      cum: 0,
      actor: human,
      text: "human prompt",
    },
    {
      type: "say",
      _row: 1,
      t: new Date(REPLY_MS).toISOString(),
      tMs: REPLY_MS,
      cum: REPLY_COST_USD,
      costDelta: REPLY_COST_USD,
      actor: agentActor,
      text: "agent reply",
    },
    {
      type: "say",
      _row: 2,
      t: new Date(REPLY_END_MS).toISOString(),
      tMs: REPLY_END_MS,
      cum: REPLY_COST_USD,
      actor: agentActor,
      text: "agent follow-up",
    },
  ];
}

function session(user: BasicUser | null): AgentSessionDetail {
  // No transcript summary: the panel paints `fallbackItems`, the projection
  // path both shells share.
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    transcripts: [],
    user,
  });
}

function renderPanel(user: BasicUser | null, items: TurnItem[]) {
  return render(
    <AppCoreStoryProviders>
      <SessionTranscriptPanel fallbackItems={items} session={session(user)} />
    </AppCoreStoryProviders>
  );
}

function gutterOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest<HTMLElement>(".st-msg");
  const gutter = row?.querySelector<HTMLElement>(".st-gut");
  if (!gutter) {
    throw new Error(`No turn gutter for ${text}`);
  }
  return gutter;
}

describe("Session trace gutter avatars (ISS-12666)", () => {
  it("names the creator and the agent in their turn gutters", () => {
    renderPanel(ADA, traceItems(humanActor("Ada Lovelace")));

    const human = within(gutterOf("human prompt")).getByRole("img", {
      name: "Ada Lovelace",
    });
    expect(human).toHaveAttribute("title", "Ada Lovelace");
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(human).toHaveTextContent(ONLY_A);
    expect(
      within(gutterOf("agent reply")).getByRole("img", { name: MODEL })
    ).toBeInTheDocument();
  });

  it("keeps each turn's timestamp, duration and cost beside the avatar", () => {
    renderPanel(ADA, traceItems(humanActor("Ada Lovelace")));

    const humanGutter = gutterOf("human prompt");
    expect(humanGutter).toHaveTextContent(formatTraceClock(PROMPT_MS) ?? "");
    const agentGutter = gutterOf("agent reply");
    expect(agentGutter).toHaveTextContent(formatTraceClock(REPLY_MS) ?? "");
    expect(agentGutter).toHaveTextContent(
      formatDurationMs(REPLY_END_MS - REPLY_MS)
    );
    expect(agentGutter).toHaveTextContent(
      formatTraceCostPrecise(REPLY_COST_USD)
    );
  });

  it("shows the creator's photo on their turns only, decorative under the named avatar", () => {
    renderPanel(ADA, traceItems(humanActor("Ada Lovelace")));

    const photo = gutterOf("human prompt").querySelector("img");
    expect(photo).toHaveAttribute("src", PHOTO_URL);
    expect(photo).toHaveAttribute("alt", "");
    expect(gutterOf("agent reply").querySelector("img")).toBeNull();
  });

  it("falls back to initials when the creator has no photo", () => {
    renderPanel(
      { ...ADA, avatarUrl: null },
      traceItems(humanActor("Ada Lovelace"))
    );

    const gutter = gutterOf("human prompt");
    expect(gutter.querySelector("img")).toBeNull();
    expect(
      within(gutter).getByRole("img", { name: "Ada Lovelace" })
    ).toHaveTextContent(ONLY_A);
  });

  it("does not present the producer's stand-in as a person when no creator resolved", () => {
    renderPanel(null, traceItems(humanActor("Local Desktop session")));

    const gutter = gutterOf("human prompt");
    expect(
      within(gutter).getByRole("img", { name: UNATTRIBUTED_ACTOR_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Local Desktop session" })
    ).not.toBeInTheDocument();
    expect(gutter.querySelector("img")).toBeNull();
    expect(
      within(gutterOf("agent reply")).getByRole("img", { name: MODEL })
    ).toBeInTheDocument();
  });

  it("renders no avatars for an empty trace", () => {
    renderPanel(ADA, []);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
