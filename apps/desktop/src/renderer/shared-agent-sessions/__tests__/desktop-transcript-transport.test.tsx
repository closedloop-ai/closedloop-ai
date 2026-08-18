import type { TranscriptFileDescriptor } from "@repo/api/src/types/desktop-transcripts";
import { useTranscriptBytesTransport } from "@repo/app/agents/data-source/transcript-bytes-transport";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopTranscriptTransportProvider } from "../desktop-transcript-transport";

const MAIN_FILE: TranscriptFileDescriptor = {
  fileKey: "main",
  availability: "available",
  url: null,
  byteSize: 10,
  rawSha256: "a".repeat(64),
  uploadedAt: "2026-07-16T00:00:00.000Z",
  lastObservedAt: "2026-07-16T00:00:00.000Z",
  permanentFailureReason: null,
};
const APP_URL = `app://renderer/transcripts/${"a".repeat(64)}.jsonl`;
const NO_URL_ERROR = /no longer available/;
const PREPARE_ERROR = /boom/;
const BRIDGE_UNAVAILABLE_ERROR = /bridge is unavailable/;
const CANCELLED_ERROR = /cancelled/;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function setPrepareTranscript(fn: unknown) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: fn === undefined ? {} : { prepareTranscript: fn },
  });
}

function DesktopWrapper({ children }: { children: ReactNode }) {
  return (
    <DesktopTranscriptTransportProvider>
      {children}
    </DesktopTranscriptTransportProvider>
  );
}

describe("transcript bytes transport", () => {
  it("web default resolves to the descriptor's signed S3 URL (cloud source)", async () => {
    const { result } = renderHook(() => useTranscriptBytesTransport());
    expect(result.current.supportsLocalFallback).toBe(false);
    const resolved = await result.current.resolveFetchUrl({
      sessionId: "s1",
      file: { ...MAIN_FILE, url: "https://bucket.s3.amazonaws.com/x?sig=1" },
    });
    expect(resolved).toEqual({
      kind: "ready",
      url: "https://bucket.s3.amazonaws.com/x?sig=1",
      source: "cloud",
    });
  });

  it("web default rejects when the descriptor has no URL", async () => {
    const { result } = renderHook(() => useTranscriptBytesTransport());
    await expect(
      result.current.resolveFetchUrl({ sessionId: "s1", file: MAIN_FILE })
    ).rejects.toThrow(NO_URL_ERROR);
  });

  it("desktop advertises local-fallback support", () => {
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    expect(result.current.supportsLocalFallback).toBe(true);
  });

  it("desktop routes through prepareTranscript and returns the app:// URL (cloud)", async () => {
    const prepare = vi.fn(async () => ({
      kind: "ready",
      url: APP_URL,
      source: "cloud",
    }));
    setPrepareTranscript(prepare);
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });

    const resolved = await result.current.resolveFetchUrl({
      sessionId: "s1",
      file: MAIN_FILE,
    });
    expect(resolved).toEqual({ kind: "ready", url: APP_URL, source: "cloud" });
    // Only ids cross the bridge — never the signed URL (SSRF prevention). A
    // per-call `requestId` correlates a later Cancel to this download (FEA-3678).
    expect(prepare).toHaveBeenCalledWith({
      sessionId: "s1",
      fileKey: "main",
      requestId: expect.any(String),
    });
  });

  it("forwards the harness externalSessionId so the local fallback can key on it", async () => {
    const prepare = vi.fn(async () => ({
      kind: "ready",
      url: APP_URL,
      source: "local",
    }));
    setPrepareTranscript(prepare);
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });

    await result.current.resolveFetchUrl({
      sessionId: "cloud-artifact-1",
      externalSessionId: "ext-harness-1",
      file: MAIN_FILE,
    });
    // The cloud id keys the read route; the harness id keys the LOCAL fallback —
    // both cross the bridge so main can distinguish them.
    expect(prepare).toHaveBeenCalledWith({
      sessionId: "cloud-artifact-1",
      externalSessionId: "ext-harness-1",
      fileKey: "main",
      requestId: expect.any(String),
    });
  });

  it("desktop surfaces the local-fallback source when main served the local copy", async () => {
    setPrepareTranscript(
      vi.fn(async () => ({ kind: "ready", url: APP_URL, source: "local" }))
    );
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    const resolved = await result.current.resolveFetchUrl({
      sessionId: "s1",
      file: MAIN_FILE,
    });
    expect(resolved).toEqual({ kind: "ready", url: APP_URL, source: "local" });
  });

  it("desktop forwards the load cap + opt-in and surfaces an oversized local result", async () => {
    const prepare = vi.fn(async () => ({
      kind: "oversized",
      byteSize: 40 * 1024 * 1024,
      source: "local",
    }));
    setPrepareTranscript(prepare);
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    const resolved = await result.current.resolveFetchUrl({
      sessionId: "s1",
      file: MAIN_FILE,
      maxAutoLoadBytes: 25 * 1024 * 1024,
    });
    expect(resolved).toEqual({
      kind: "oversized",
      byteSize: 40 * 1024 * 1024,
      source: "local",
    });
    // The cap crosses the bridge; the opt-in flag is omitted when false.
    expect(prepare).toHaveBeenCalledWith({
      sessionId: "s1",
      fileKey: "main",
      maxAutoLoadBytes: 25 * 1024 * 1024,
      requestId: expect.any(String),
    });
  });

  it("desktop forwards allowOversized once the user opts in", async () => {
    const prepare = vi.fn(async () => ({
      kind: "ready",
      url: APP_URL,
      source: "local",
    }));
    setPrepareTranscript(prepare);
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    await result.current.resolveFetchUrl({
      sessionId: "s1",
      file: MAIN_FILE,
      maxAutoLoadBytes: 25 * 1024 * 1024,
      allowOversized: true,
    });
    expect(prepare).toHaveBeenCalledWith({
      sessionId: "s1",
      fileKey: "main",
      maxAutoLoadBytes: 25 * 1024 * 1024,
      allowOversized: true,
      requestId: expect.any(String),
    });
  });

  it("desktop surfaces a prepare error as a thrown transcript error", async () => {
    setPrepareTranscript(
      vi.fn(async () => ({ kind: "error", message: "boom" }))
    );
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    await expect(
      result.current.resolveFetchUrl({ sessionId: "s1", file: MAIN_FILE })
    ).rejects.toThrow(PREPARE_ERROR);
  });

  it("desktop fails clearly when the bridge is unavailable", async () => {
    setPrepareTranscript(undefined);
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    await expect(
      result.current.resolveFetchUrl({ sessionId: "s1", file: MAIN_FILE })
    ).rejects.toThrow(BRIDGE_UNAVAILABLE_ERROR);
  });

  it("aborting the query cancels the in-flight main-process download (FEA-3678)", () => {
    const controller = new AbortController();
    let capturedRequestId: string | undefined;
    // The S3 download runs in main and this prepare never resolves on its own —
    // it stands in for an in-flight transfer until the user cancels.
    const prepare = vi.fn((request: { requestId?: string }) => {
      capturedRequestId = request.requestId;
      return new Promise(() => {
        // never resolves
      });
    });
    const cancel = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { prepareTranscript: prepare, cancelTranscriptPrepare: cancel },
    });
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });

    // Kick off the resolve; it stays pending (the "download" is in flight).
    result.current
      .resolveFetchUrl({
        sessionId: "s1",
        file: MAIN_FILE,
        signal: controller.signal,
      })
      .catch(() => undefined);
    expect(capturedRequestId).toEqual(expect.any(String));
    expect(cancel).not.toHaveBeenCalled();

    // The user clicks Cancel → the query signal aborts → main is told to abort
    // the matching download by its requestId (so the S3 egress stops).
    controller.abort();
    expect(cancel).toHaveBeenCalledWith({ requestId: capturedRequestId });
  });

  it("never starts a download when the signal is already aborted", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const prepare = vi.fn(() => new Promise(() => undefined));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { prepareTranscript: prepare, cancelTranscriptPrepare: cancel },
    });
    const { result } = renderHook(() => useTranscriptBytesTransport(), {
      wrapper: DesktopWrapper,
    });
    // An already-cancelled read must NOT kick off a main-process download (a
    // fire-and-forget cancel here would race its own prepare and leave the
    // download running uncancelled — the exact FEA-3678 egress waste).
    await expect(
      result.current.resolveFetchUrl({
        sessionId: "s1",
        file: MAIN_FILE,
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow(CANCELLED_ERROR);
    expect(prepare).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
