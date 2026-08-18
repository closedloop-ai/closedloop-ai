import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import type { RelayHttpRequestPayload } from "@repo/shared-platform/relay-request-model";
import { RelayClient } from "@/lib/engineer/relay-client";

const COMMAND_ID = "cmd-1";
const TARGET_ID = "target-1";
const RE_COMMANDS_PATH = /\/commands$/;

function healthCheckRequest(): RelayHttpRequestPayload {
  return {
    method: "GET",
    path: "/api/gateway/health-check",
    headers: { "content-type": "application/json" },
    body: { kind: "json", value: {} },
  };
}

/**
 * A command-events body that never produces an event, standing in for a desktop
 * that accepted the command and is still working on it.
 *
 * It models `fetch`'s own abort contract rather than ignoring the signal: an
 * aborted request errors the body stream. That is the behavior under test — if
 * the signal never reaches here, the read simply hangs, which is exactly the
 * 120s-stream leak this covers.
 */
function stalledEventsResponse(signal: AbortSignal | null): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

/**
 * Stubs `fetch` for the two calls `executeOperation` makes: creating the
 * command, then opening its result stream. Records every signal handed to the
 * stream call so the test can assert on cancellation.
 */
function stubRelayFetch(streamSignals: AbortSignal[]) {
  globalThis.fetch = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (RE_COMMANDS_PATH.test(url)) {
        return Promise.resolve(
          Response.json({ success: true, data: { commandId: COMMAND_ID } })
        );
      }

      const signal = init?.signal ?? null;
      if (signal) {
        streamSignals.push(signal);
      }
      if (signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(stalledEventsResponse(signal));
    }
  ) as unknown as typeof globalThis.fetch;
}

describe("RelayClient.executeOperation cancellation (ISS-5169)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("tears the result stream down when the caller's signal aborts", async () => {
    const streamSignals: AbortSignal[] = [];
    stubRelayFetch(streamSignals);

    const controller = new AbortController();
    const client = new RelayClient("https://api.test", "token");
    const operation = client.executeOperation(
      TARGET_ID,
      healthCheckRequest(),
      undefined,
      { signal: controller.signal }
    );
    const settled = operation.then(
      () => "resolved" as const,
      () => "rejected" as const
    );

    // The stream must be open and reading before the abort means anything.
    await vi.waitFor(() => {
      expect(streamSignals).toHaveLength(1);
    });
    expect(streamSignals[0]?.aborted).toBe(false);

    controller.abort();

    // The caller's cancellation reaches the stream instead of leaving it to run
    // out its own RESULT_STREAM_TIMEOUT_MS while a retry opens a second one.
    expect(streamSignals[0]?.aborted).toBe(true);
    await expect(settled).resolves.toBe("rejected");
  });

  it("does not hand a live stream to an already-aborted caller", async () => {
    const streamSignals: AbortSignal[] = [];
    stubRelayFetch(streamSignals);

    const controller = new AbortController();
    controller.abort();
    const client = new RelayClient("https://api.test", "token");

    await expect(
      client.executeOperation(TARGET_ID, healthCheckRequest(), undefined, {
        signal: controller.signal,
      })
    ).rejects.toBeDefined();

    expect(streamSignals).not.toHaveLength(0);
    expect(streamSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("leaves the stream running when the caller passes no signal", async () => {
    const streamSignals: AbortSignal[] = [];
    stubRelayFetch(streamSignals);

    const client = new RelayClient("https://api.test", "token");
    // Swallow the eventual rejection when the suite tears the stub down; the
    // assertion below is about the stream still being live right now.
    client
      .executeOperation(TARGET_ID, healthCheckRequest())
      .catch(() => undefined);

    await vi.waitFor(() => {
      expect(streamSignals).toHaveLength(1);
    });

    // Without a caller signal the stream keeps its own budget — the opt-in must
    // not change behavior for every other relay command.
    expect(streamSignals[0]?.aborted).toBe(false);
  });
});
