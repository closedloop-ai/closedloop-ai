import { describe, expect, it } from "vitest";
import {
  MAIN_TRANSCRIPT_FILE_KEY,
  readTranscriptFileKey,
  withTranscriptFileParam,
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
