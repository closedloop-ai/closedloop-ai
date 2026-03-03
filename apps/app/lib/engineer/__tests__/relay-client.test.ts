import { describe, expect, it } from "vitest";
import { isStreamingEngineerRequest } from "@/lib/engineer/relay-client";

describe("isStreamingEngineerRequest", () => {
  it("identifies known streaming engineer endpoints", () => {
    expect(
      isStreamingEngineerRequest(
        "POST",
        "/api/engineer/symphony/chat/ENG-123?repo=%2Ftmp%2Frepo",
        null
      )
    ).toBe(true);

    expect(
      isStreamingEngineerRequest(
        "POST",
        "/api/engineer/codex/review/ENG-123",
        null
      )
    ).toBe(true);
  });

  it("does not classify non-streaming endpoints by default", () => {
    expect(
      isStreamingEngineerRequest("GET", "/api/engineer/health-check", null)
    ).toBe(false);
    expect(isStreamingEngineerRequest("POST", "/api/engineer/git", null)).toBe(
      false
    );
  });

  it("honors explicit event-stream accept header", () => {
    expect(
      isStreamingEngineerRequest(
        "POST",
        "/api/engineer/git",
        "application/json, text/event-stream"
      )
    ).toBe(true);
  });
});
