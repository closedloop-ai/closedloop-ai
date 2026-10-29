import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import { useTraceComments } from "../use-trace-comments";
import { createTraceCommentsWrapper } from "./trace-comments-test-helpers";

/**
 * ISS-11004 (whitlockk, PR #8562): an Activity link can name a thread past the
 * rail's collection cap, so the rail's read asks for that thread by name.
 */
const THREAD_ID = "00000000-0000-7000-8000-0000000000aa";

function sourceWithList() {
  const list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]);
  const dataSource: TraceCommentsDataSource = {
    scope: "test",
    list,
    create: vi.fn<TraceCommentsDataSource["create"]>(),
    reply: vi.fn<TraceCommentsDataSource["reply"]>(),
    update: vi.fn<TraceCommentsDataSource["update"]>(),
    delete: vi.fn<TraceCommentsDataSource["delete"]>(),
  };
  return { dataSource, list };
}

describe("useTraceComments addressed thread", () => {
  it("asks the source for the addressed thread", async () => {
    const { dataSource, list } = sourceWithList();

    renderHook(
      () =>
        useTraceComments({
          includeThreadId: THREAD_ID,
          onJumpToRow: vi.fn(),
          target: { type: "session", id: "session-1" },
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        { type: "session", id: "session-1" },
        undefined,
        expect.objectContaining({ includeThreadId: THREAD_ID })
      )
    );
  });

  it("leaves the read unaddressed when no thread is named", async () => {
    const { dataSource, list } = sourceWithList();

    renderHook(
      () =>
        useTraceComments({
          onJumpToRow: vi.fn(),
          target: { type: "session", id: "session-1" },
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(list.mock.calls[0]?.[2]).not.toHaveProperty("includeThreadId");
  });
});
