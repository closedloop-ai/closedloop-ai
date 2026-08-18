import {
  type TraceComment,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { API_TIMEOUT_ERROR_CODE } from "@repo/app/shared/api/api-timeout";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../types/desktop-api";
import { createDesktopTraceCommentsDataSource } from "../desktop-trace-comments-data-source";

const target = { type: TraceCommentTargetType.Session, id: "session-1" };
/** Mirrors the caller's `TRACE_COMMENTS_READ_TIMEOUT_MS`; any bound works here. */
const READ_TIMEOUT_MS = 4000;

/**
 * ISS-5110: the local IPC round-trip carries no cancellation of its own, so the
 * renderer bounds the WAIT. Before this, a wedged `list` never settled and — with
 * the rail's single-flight guard — blocked every later poll for that surface.
 */
describe("Desktop trace-comments read deadline (ISS-5110)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails a hung IPC read on its deadline instead of waiting forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const list = vi.fn(() => neverSettles());
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({ list }),
    });

    const read = dataSource.list(target, undefined, {
      timeoutMs: READ_TIMEOUT_MS,
    });
    const rejection = expect(read).rejects.toMatchObject({
      code: API_TIMEOUT_ERROR_CODE,
      name: "ApiError",
    });

    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);

    await rejection;
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reports a caller cancellation as an abort, not as a deadline expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({ list: vi.fn(neverSettles) }),
    });
    const controller = new AbortController();

    const read = dataSource.list(target, undefined, {
      signal: controller.signal,
      timeoutMs: READ_TIMEOUT_MS,
    });
    const rejection = expect(read).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();

    await rejection;
  });

  it("joins a concurrent read for the same collection instead of issuing a second IPC call", async () => {
    let settle: ((comments: TraceComment[]) => void) | undefined;
    const list = vi.fn(
      () =>
        new Promise<TraceComment[]>((resolve) => {
          settle = resolve;
        })
    );
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({ list }),
    });

    const first = dataSource.list(target, undefined, {
      timeoutMs: READ_TIMEOUT_MS,
    });
    const joined = dataSource.list(target, undefined, {
      timeoutMs: READ_TIMEOUT_MS,
    });
    settle?.([]);

    await expect(first).resolves.toEqual([]);
    await expect(joined).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);

    // The entry is released on settle, so a later read is a fresh round-trip
    // rather than a permanently cached one.
    const next = dataSource.list(target, undefined, {
      timeoutMs: READ_TIMEOUT_MS,
    });
    settle?.([]);
    await expect(next).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not stack another IPC call after a wedged read's deadline releases the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const list = vi.fn(neverSettles);
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({ list }),
    });

    expect(
      await runOutDeadline(
        dataSource.list(target, undefined, { timeoutMs: READ_TIMEOUT_MS })
      )
    ).toMatchObject({ code: API_TIMEOUT_ERROR_CODE, name: "ApiError" });
    expect(
      await runOutDeadline(
        dataSource.list(target, undefined, { timeoutMs: READ_TIMEOUT_MS })
      )
    ).toMatchObject({ code: API_TIMEOUT_ERROR_CODE, name: "ApiError" });

    // The wedged round-trip is still outstanding, so the second read joined it
    // instead of adding another pending IPC call.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("releases the coalescing entry when the underlying read rejects", async () => {
    const list = vi.fn(() => Promise.reject(new Error("ipc failed")));
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({ list }),
    });

    await expect(
      dataSource.list(target, undefined, { timeoutMs: READ_TIMEOUT_MS })
    ).rejects.toThrow("ipc failed");
    await expect(
      dataSource.list(target, undefined, { timeoutMs: READ_TIMEOUT_MS })
    ).rejects.toThrow("ipc failed");

    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not let two collections on one target share a read", async () => {
    const list = vi.fn(() => Promise.resolve([]));
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({ list }),
    });
    const branchTarget = {
      type: TraceCommentTargetType.Branch,
      id: "branch-1",
    };

    await Promise.all([
      dataSource.list(
        branchTarget,
        { surface: TraceCommentSurface.BranchDetail },
        { timeoutMs: READ_TIMEOUT_MS }
      ),
      dataSource.list(
        branchTarget,
        { surface: TraceCommentSurface.BranchTimeline },
        { timeoutMs: READ_TIMEOUT_MS }
      ),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
  });

  it("still resolves a read that answers inside its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi: traceCommentsApiMock({
        list: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(
      dataSource.list(target, undefined, { timeoutMs: READ_TIMEOUT_MS })
    ).resolves.toEqual([]);
  });
});

/** Runs the read deadline out and hands back whatever the caller saw. */
async function runOutDeadline(read: Promise<unknown>): Promise<unknown> {
  const settled = read.then(
    () => undefined,
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  return await settled;
}

function neverSettles(): Promise<TraceComment[]> {
  return new Promise<TraceComment[]>(() => {
    // Models a wedged IPC round-trip: no resolve, no reject, ever.
  });
}

function traceCommentsApiMock(
  overrides: Partial<DesktopApi["traceCommentsApi"]> = {}
): DesktopApi["traceCommentsApi"] {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    reply: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}
