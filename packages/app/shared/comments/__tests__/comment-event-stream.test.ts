import { describe, expect, it } from "vitest";
import { commentsChannel } from "../comment-event-stream";
import { ARTIFACT_ID, ORG_ID } from "./comments-test-source";

describe("commentsChannel", () => {
  it("has no channel until both ids are known, or for an id the grammar refuses", () => {
    expect(commentsChannel(undefined, ARTIFACT_ID)).toBeNull();
    expect(commentsChannel(ORG_ID, null)).toBeNull();
    expect(commentsChannel(ORG_ID.toUpperCase(), ARTIFACT_ID)).toBeNull();
  });
});
