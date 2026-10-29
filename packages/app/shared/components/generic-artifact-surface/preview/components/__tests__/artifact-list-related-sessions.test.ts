import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ArtifactSessionTrace,
  type ArtifactWritingSession,
  genericArtifactSessionTrace,
  genericArtifacts,
} from "../../fixtures";
import { ArtifactTypeIcons } from "../artifact-icons";
import {
  defaultRelatedSessionsForArtifact,
  relatedSessionOptions,
} from "../artifact-list-related-sessions";

const artifact = genericArtifacts[0]!;

function session(
  id: string,
  overrides: Partial<ArtifactWritingSession> = {}
): ArtifactWritingSession {
  return {
    contributor: `Contributor ${id}`,
    contributorInitials: id.toUpperCase(),
    duration: "5m",
    id,
    model: "model",
    outcome: "outcome",
    phases: [],
    prompt: "prompt",
    startedAt: "not a time",
    title: `Session ${id}`,
    ...overrides,
  };
}

function trace(
  sessions: readonly ArtifactWritingSession[]
): ArtifactSessionTrace {
  return {
    endAt: "11:20am",
    sessions,
    startAt: "9:02am",
    startDate: "2026-07-18",
    wallClock: "2h 18m",
  };
}

function ids(sessions: readonly ArtifactWritingSession[]): string[] {
  return relatedSessionOptions(artifact, trace(sessions)).map(
    (option) => option.id
  );
}

describe("relatedSessionOptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a session into a reference option with derived fallbacks", () => {
    const [option] = relatedSessionOptions(
      { ...artifact, slug: "FEA-2481" },
      trace([
        session("a", {
          lastInteractionDate: "2026-07-18",
          lastInteractionTraceRow: 7,
          startedAt: "9:05am",
          title: "Drafted the spec",
        }),
      ])
    );

    expect(option).toEqual({
      icon: ArtifactTypeIcons.Session,
      id: "a",
      lastInteractionAt: "9:05am",
      lastInteractionDate: "2026-07-18",
      lastInteractionTraceRow: 7,
      ownerInitials: "A",
      ownerName: "Contributor a",
      relationship: "wrote",
      slug: "SES-2481-1",
      status: "active",
      title: "Drafted the spec",
    });
  });

  it("derives relationship and status only when the session omits them", () => {
    const options = relatedSessionOptions(
      { ...artifact, slug: "SOLO" },
      trace([
        session("a", { title: "Replied to a Comment thread" }),
        session("b", { relationship: "commented", title: "Wrote code" }),
        session("c", { status: "completed" }),
      ])
    );

    expect(
      options.map(({ id, relationship, slug, status }) => ({
        id,
        relationship,
        slug,
        status,
      }))
    ).toEqual([
      {
        id: "a",
        relationship: "commented",
        slug: "SES-SOLO-1",
        status: "completed",
      },
      {
        id: "b",
        relationship: "commented",
        slug: "SES-SOLO-2",
        status: "completed",
      },
      {
        id: "c",
        relationship: "wrote",
        slug: "SES-SOLO-3",
        status: "completed",
      },
    ]);
  });

  it("orders by latest interaction, converting 12-hour clock periods", () => {
    expect(
      ids([
        session("prev-day", {
          lastInteractionAt: "9:00",
          lastInteractionDate: "2026-07-17",
        }),
        session("midnight", {
          lastInteractionAt: "12:30am",
          lastInteractionDate: "2026-07-18",
        }),
        session("noon", {
          lastInteractionAt: " 12:15PM ",
          lastInteractionDate: "2026-07-18",
        }),
        session("afternoon", {
          lastInteractionAt: "1:00pm",
          lastInteractionDate: "2026-07-18",
        }),
      ])
    ).toEqual(["afternoon", "noon", "midnight", "prev-day"]);
  });

  it("treats an undated time as today and an unparseable date as epoch", () => {
    expect(
      ids([
        session("bad-date", {
          lastInteractionAt: "11:00pm",
          lastInteractionDate: "not-a-date",
        }),
        session("dated", {
          lastInteractionAt: "11:00pm",
          lastInteractionDate: "2026-07-19",
        }),
        session("today", { lastInteractionAt: "8:00am" }),
      ])
    ).toEqual(["today", "dated", "bad-date"]);
  });

  it("puts active sessions first among equal recency and keeps other ties stable", () => {
    expect(
      ids([
        session("first-done", { status: "completed" }),
        session("running", { status: "active" }),
        session("second-done", { status: "completed" }),
        session("timed", {
          lastInteractionAt: "1:00am",
          lastInteractionDate: "not-a-date",
          status: "completed",
        }),
      ])
    ).toEqual(["timed", "running", "first-done", "second-done"]);
  });
});

describe("defaultRelatedSessionsForArtifact", () => {
  it("returns the shared fixture trace", () => {
    expect(defaultRelatedSessionsForArtifact()).toBe(
      genericArtifactSessionTrace
    );
  });
});
