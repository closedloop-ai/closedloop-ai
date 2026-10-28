import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { log } from "@repo/observability/log";
import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "./comment-data-invalid";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportCommentDataInvalid", () => {
  it("logs the monitored event at error level, with optional ids omitted when absent", () => {
    reportCommentDataInvalid({
      reason: CommentDataInvalidReason.AnchorMissing,
      organizationId: "org-1",
    });

    // The literal is the log monitor's match (ISS-11554), so it is spelled out
    // here rather than read from the constant it would otherwise agree with.
    expect(log.error).toHaveBeenCalledWith("comments.data_invalid", {
      event: "comments.data_invalid",
      reason: CommentDataInvalidReason.AnchorMissing,
      organizationId: "org-1",
    });
  });

  it("logs an artifact-less thread at warn, since rooms outlive deleted artifacts", () => {
    reportCommentDataInvalid({
      reason: CommentDataInvalidReason.ThreadWithoutArtifact,
      organizationId: "org-1",
      threadId: "th-1",
      roomId: "room-1",
    });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("comments.data_invalid", {
      event: "comments.data_invalid",
      reason: CommentDataInvalidReason.ThreadWithoutArtifact,
      organizationId: "org-1",
      threadId: "th-1",
      roomId: "room-1",
    });
  });
});
