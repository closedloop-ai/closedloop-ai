import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  MAIN_TRANSCRIPT_FILE_KEY,
  readTranscriptFileKey,
  readTranscriptInvocationAnchor,
  withTranscriptFileParam,
  withTranscriptInvocationParams,
} from "../session-transcript-href";

describe("withTranscriptFileParam", () => {
  it("returns the bare href for the main file", () => {
    expect(withTranscriptFileParam("/org/sessions/s1", "main")).toBe(
      "/org/sessions/s1"
    );
    expect(withTranscriptFileParam("/org/sessions/s1", "")).toBe(
      "/org/sessions/s1"
    );
  });

  it("adds an encoded file param for a subagent file", () => {
    expect(
      withTranscriptFileParam("/org/sessions/s1", "subagent:agent-7")
    ).toBe("/org/sessions/s1?file=subagent%3Aagent-7");
  });

  it("preserves an existing query string", () => {
    const href = withTranscriptFileParam(
      "/org/sessions/s1?tab=trace",
      "subagent:a1"
    );
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("tab")).toBe("trace");
    expect(params.get("file")).toBe("subagent:a1");
  });
});

describe("invocation transcript anchors", () => {
  it("round-trips a file plus provider-backed event anchor", () => {
    const anchor = {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
      providerToolUseId: "toolu_1",
    } as const;
    const href = withTranscriptInvocationParams(
      "/org/sessions/s1",
      "subagent:agent-7",
      anchor
    );
    const params = new URLSearchParams(href.split("?")[1]);

    expect(readTranscriptFileKey(params)).toBe("subagent:agent-7");
    expect(readTranscriptInvocationAnchor(params)).toEqual(anchor);
  });

  it("parses every supported stable anchor identity", () => {
    const anchors = [
      {
        kind: AgentComponentInvocationAnchorKind.Agent,
        agentId: "agent-row-1",
        externalAgentId: "agent-native-1",
      },
      {
        kind: AgentComponentInvocationAnchorKind.UserTurn,
        userTurnId: "prompt-1",
      },
      {
        kind: AgentComponentInvocationAnchorKind.Timestamp,
        timestamp: "2026-07-22T12:00:00.000Z",
        ordinal: 2,
      },
    ] as const;

    for (const anchor of anchors) {
      const href = withTranscriptInvocationParams(
        "/sessions/s1",
        "main",
        anchor
      );
      expect(
        readTranscriptInvocationAnchor(new URLSearchParams(href.split("?")[1]))
      ).toEqual(anchor);
    }
  });

  it("treats malformed or unsafe anchors as absent", () => {
    expect(
      readTranscriptInvocationAnchor(
        new URLSearchParams("invocationAnchor=%7Bbad-json")
      )
    ).toBeNull();
    expect(
      readTranscriptInvocationAnchor({
        invocationAnchor: JSON.stringify({
          kind: AgentComponentInvocationAnchorKind.Timestamp,
          timestamp: "not-a-date",
          ordinal: -1,
        }),
      })
    ).toBeNull();
  });
});

describe("readTranscriptFileKey", () => {
  it("defaults to the main file", () => {
    expect(readTranscriptFileKey(undefined)).toBe(MAIN_TRANSCRIPT_FILE_KEY);
    expect(readTranscriptFileKey(null)).toBe(MAIN_TRANSCRIPT_FILE_KEY);
    expect(readTranscriptFileKey({})).toBe(MAIN_TRANSCRIPT_FILE_KEY);
    expect(readTranscriptFileKey(new URLSearchParams())).toBe(
      MAIN_TRANSCRIPT_FILE_KEY
    );
  });

  it("reads the file param from URLSearchParams and records", () => {
    expect(readTranscriptFileKey(new URLSearchParams("file=subagent:a1"))).toBe(
      "subagent:a1"
    );
    expect(readTranscriptFileKey({ file: "subagent:a2" })).toBe("subagent:a2");
    expect(readTranscriptFileKey({ file: ["subagent:a3"] })).toBe(
      "subagent:a3"
    );
  });
});
