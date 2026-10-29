import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/comments/comment-data-invalid", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/comments/comment-data-invalid")
  >()),
  reportCommentDataInvalid: vi.fn(),
}));

import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "@/app/comments/comment-data-invalid";
import {
  readStoredCommentAnchor,
  resetReportedTraceAnchorFailures,
} from "./trace-comment-anchor-json";

const THREAD = { organizationId: "org-1", threadId: "thread-1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetReportedTraceAnchorFailures();
});

describe("readStoredCommentAnchor", () => {
  it("keeps a thread with no stored anchor and reports it as anchor_missing, as the legacy read does", () => {
    expect(readStoredCommentAnchor(null, THREAD)).toBeNull();
    expect(reportCommentDataInvalid).toHaveBeenCalledWith({
      reason: CommentDataInvalidReason.AnchorMissing,
      ...THREAD,
    });
  });

  it("leaves out an unreadable anchor and reports it as anchor_unparseable", () => {
    expect(readStoredCommentAnchor({ v: -1 }, THREAD)).toBeUndefined();
    expect(reportCommentDataInvalid).toHaveBeenCalledWith({
      reason: CommentDataInvalidReason.AnchorUnparseable,
      ...THREAD,
    });
  });
});
