import { EventEmitter } from "node:events";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOC_SYNC_UNCAUGHT_EXCEPTION_EVENT,
  DOC_SYNC_UNHANDLED_REJECTION_EVENT,
  installProcessFaultHandlers,
} from "../lifecycle/process-faults";

const SENTINEL = "sentinel-message";
const FRAMES_ONLY = /^(\s+at .*\n?)+$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installProcessFaultHandlers", () => {
  it("logs an unhandled rejection's code and stack frames, and keeps running", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const target = new EventEmitter();
    const onFatal = vi.fn();
    installProcessFaultHandlers({ onFatal, target });

    target.emit(
      "unhandledRejection",
      Object.assign(new Error(SENTINEL), { code: "ECONNRESET" })
    );

    expect(error).toHaveBeenCalledWith("Doc sync unhandled rejection", {
      event: DOC_SYNC_UNHANDLED_REJECTION_EVENT,
      code: "ECONNRESET",
      stack: expect.stringMatching(FRAMES_ONLY),
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(SENTINEL);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("logs no stack for a rejection that is not an Error", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const target = new EventEmitter();
    installProcessFaultHandlers({ onFatal: vi.fn(), target });

    target.emit("unhandledRejection", SENTINEL);

    expect(error).toHaveBeenCalledWith("Doc sync unhandled rejection", {
      event: DOC_SYNC_UNHANDLED_REJECTION_EVENT,
      code: "unknown",
    });
  });

  it("logs an uncaught exception as fatal and runs onFatal exactly once", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const target = new EventEmitter();
    const onFatal = vi.fn();
    installProcessFaultHandlers({ onFatal, target });

    target.emit("uncaughtException", new TypeError(SENTINEL));
    target.emit("uncaughtException", new TypeError(SENTINEL));

    expect(error).toHaveBeenNthCalledWith(1, "Doc sync uncaught exception", {
      event: DOC_SYNC_UNCAUGHT_EXCEPTION_EVENT,
      code: "TypeError",
      stack: expect.stringMatching(FRAMES_ONLY),
      fatal: true,
    });
    expect(error).toHaveBeenCalledTimes(2);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain(SENTINEL);
  });

  it("removes both listeners when uninstalled", () => {
    const target = new EventEmitter();
    const uninstall = installProcessFaultHandlers({ onFatal: vi.fn(), target });

    uninstall();

    expect(target.listenerCount("unhandledRejection")).toBe(0);
    expect(target.listenerCount("uncaughtException")).toBe(0);
  });
});
