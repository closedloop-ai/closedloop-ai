import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFileAccessBlocks } from "../../../hooks/use-ingest-progress";
import { SessionsFileAccessBanner } from "../sessions-file-access-banner";

// The banner's older-preload copy, asserted when the reimport IPC is absent.
const RESTART_COPY = /restart Closedloop/;

// FEA-3639: the additive runtime-status field must degrade gracefully — an older
// main process that never sends `fileAccessBlocks` keeps the prompt hidden.
describe("parseFileAccessBlocks", () => {
  it("returns the blocks when the field is present", () => {
    const blocks = [{ harness: "codex", path: "~/.codex/sessions" }];
    expect(parseFileAccessBlocks({ fileAccessBlocks: blocks })).toEqual(blocks);
  });

  it("degrades to an empty array when the field is absent or malformed", () => {
    expect(parseFileAccessBlocks({})).toEqual([]);
    expect(parseFileAccessBlocks(null)).toEqual([]);
    expect(parseFileAccessBlocks({ fileAccessBlocks: null })).toEqual([]);
  });

  it("drops malformed array entries at the IPC boundary", () => {
    // A version-skewed main process could ship a null/partial entry; it must be
    // dropped here rather than reaching the banner and throwing on block.harness.
    expect(parseFileAccessBlocks({ fileAccessBlocks: [null] })).toEqual([]);
    expect(
      parseFileAccessBlocks({ fileAccessBlocks: [{ harness: "codex" }] })
    ).toEqual([]);
    const valid = { harness: "codex", path: "~/.codex/sessions" };
    expect(
      parseFileAccessBlocks({
        fileAccessBlocks: [valid, null, { path: 42 }],
      })
    ).toEqual([valid]);
  });
});

describe("SessionsFileAccessBanner", () => {
  let desktopApiDescriptor: PropertyDescriptor | undefined;
  let reimportAgentSessions: ReturnType<typeof vi.fn>;
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    reimportAgentSessions = vi.fn().mockResolvedValue(undefined);
    getRuntimeStatus = vi.fn(() => Promise.resolve({ fileAccessBlocks: [] }));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus, reimportAgentSessions },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("renders nothing when no root is blocked", async () => {
    render(<SessionsFileAccessBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Waiting on file access")).toBeNull();
  });

  it("names the blocked root and reloads on demand once access is granted", async () => {
    getRuntimeStatus.mockResolvedValue({
      fileAccessBlocks: [{ harness: "codex", path: "~/.codex/sessions" }],
    });
    render(<SessionsFileAccessBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Waiting on file access")).toBeTruthy();
    expect(screen.getByText("~/.codex/sessions")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reimportAgentSessions).toHaveBeenCalledTimes(1);
  });

  it("hides the Reload button and says to restart when the reimport IPC is unavailable", async () => {
    // Older preload build (version skew): no `reimportAgentSessions`. The button
    // must not render an enabled control that silently does nothing.
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      writable: true,
      value: {
        getRuntimeStatus: vi.fn(() =>
          Promise.resolve({
            fileAccessBlocks: [{ harness: "codex", path: "~/.codex/sessions" }],
          })
        ),
      },
    });
    render(<SessionsFileAccessBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Waiting on file access")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.getByText(RESTART_COPY)).toBeTruthy();
  });
});
