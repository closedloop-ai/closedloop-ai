/**
 * Unit tests for apps/api/lib/slack-notifier.ts
 *
 * Verifies:
 * (a) postToSlack — successful post (fetch returns { ok: true })
 * (b) postToSlack — Slack API error ({ ok: false, error: "channel_not_found" }) does not throw
 * (c) postToSlack — network failure (fetch throws) does not throw
 * (d) notifySlack — missing SLACK_BOT_TOKEN returns early without calling fetch
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

// notifySlack reads SLACK_BOT_TOKEN from the validated `@/env`. Mocking it with
// a live getter keeps the typed-env contract while letting individual tests
// toggle the token via process.env (and avoids booting the full env graph).
vi.mock("@/env", () => ({
  env: {
    get SLACK_BOT_TOKEN() {
      return process.env.SLACK_BOT_TOKEN;
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  buildAlertText,
  buildCorrelationId,
  notifySlack,
  postToSlack,
  postToSlackChannel,
} from "@/lib/slack-notifier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORRELATION_ID_REGEX = /^ts=\d{4}-\d{2}-\d{2}T/;

function makeJsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

function makeThrowingFetch(message: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message));
}

const TEST_TOKEN = "xoxb-test-token";
const TEST_TEXT = "Test alert message";

// ---------------------------------------------------------------------------
// postToSlack tests
// ---------------------------------------------------------------------------

describe("postToSlack", () => {
  it("(a) returns { ok: true } when fetch succeeds with ok response", async () => {
    const mockFetch = makeJsonFetch({
      ok: true,
      ts: "12345.67890",
      channel: "C0ABC",
    });

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${TEST_TOKEN}`,
        }),
        body: expect.stringContaining(TEST_TEXT),
      })
    );
  });

  it("(b) returns { ok: false, error: 'channel_not_found' } when Slack returns an error — does not throw", async () => {
    const mockFetch = makeJsonFetch({ ok: false, error: "channel_not_found" });

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("(c) returns { ok: false } when fetch throws a network error — does not throw", async () => {
    const mockFetch = makeThrowingFetch("Failed to connect");

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Failed to connect");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("(d) flags HTTP 5xx as retryable without consulting the (non-JSON) body", async () => {
    const json = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json,
    } as unknown as Response);

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toBe("http_503");
    // A real 5xx returns HTML; the body must not be parsed.
    expect(json).not.toHaveBeenCalled();
  });

  it("(e) flags HTTP 429 as retryable", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn(),
    } as unknown as Response);

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.retryable).toBe(true);
    expect(result.error).toBe("http_429");
  });

  it("(f) flags an app-level 'ratelimited' error as a retryable failure", async () => {
    const mockFetch = makeJsonFetch({ ok: false, error: "ratelimited" });

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("(g) does not flag a non-transient API error as retryable", async () => {
    const mockFetch = makeJsonFetch({ ok: false, error: "channel_not_found" });

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.retryable).toBe(false);
  });

  it("(h) flags a transient app-level error (HTTP 200 'service_unavailable') as retryable", async () => {
    const mockFetch = makeJsonFetch({
      ok: false,
      error: "service_unavailable",
    });

    const result = await postToSlack(TEST_TOKEN, TEST_TEXT, mockFetch);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// postToSlackChannel tests
// ---------------------------------------------------------------------------

describe("postToSlackChannel", () => {
  it("posts to the explicit channel rather than the ops-channel constant", async () => {
    const mockFetch = makeJsonFetch({ ok: true, ts: "1.2", channel: "C0ORG" });

    const result = await postToSlackChannel(
      TEST_TOKEN,
      "C0ORG",
      TEST_TEXT,
      mockFetch
    );

    expect(result.ok).toBe(true);
    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      channel: "C0ORG",
      text: TEST_TEXT,
    });
  });

  it("never throws on a network failure — resolves with an error result", async () => {
    const mockFetch = makeThrowingFetch("boom");

    const result = await postToSlackChannel(
      TEST_TOKEN,
      "C0ORG",
      TEST_TEXT,
      mockFetch
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// notifySlack tests
// ---------------------------------------------------------------------------

describe("notifySlack", () => {
  const baseOpts = {
    route: "cleanup-preview-schemas:daily",
    message: "Something went wrong",
    correlationId: "ts=2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    // Defensive: if a retry test threw before its own cleanup, ensure fake
    // timers never leak into later tests in this file.
    vi.useRealTimers();
  });

  it("(d) returns early without calling fetch when SLACK_BOT_TOKEN is absent", async () => {
    delete process.env.SLACK_BOT_TOKEN;

    // notifySlack uses global fetch internally; spy on it to confirm no call
    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Response);

    await notifySlack(baseOpts);

    expect(globalFetchSpy).not.toHaveBeenCalled();

    globalFetchSpy.mockRestore();
  });

  it("calls fetch exactly once on a successful post", async () => {
    process.env.SLACK_BOT_TOKEN = TEST_TOKEN;

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, ts: "111.222", channel: "C0A86M2KAG6" }),
    } as unknown as Response);

    await notifySlack(baseOpts);

    expect(globalFetchSpy).toHaveBeenCalledOnce();

    globalFetchSpy.mockRestore();
  });

  it("does not throw when Slack returns a non-retryable API error", async () => {
    process.env.SLACK_BOT_TOKEN = TEST_TOKEN;

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "channel_not_found" }),
    } as unknown as Response);

    await expect(notifySlack(baseOpts)).resolves.toBeUndefined();
    expect(globalFetchSpy).toHaveBeenCalledOnce();

    globalFetchSpy.mockRestore();
  });

  it("does not throw when fetch throws a network error", async () => {
    process.env.SLACK_BOT_TOKEN = TEST_TOKEN;

    const globalFetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(notifySlack(baseOpts)).resolves.toBeUndefined();

    globalFetchSpy.mockRestore();
  });

  it("retries once on a retryable Slack error and does not throw", async () => {
    process.env.SLACK_BOT_TOKEN = TEST_TOKEN;
    vi.useFakeTimers();

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: false, error: "ratelimited" }),
    } as unknown as Response);

    const promise = notifySlack(baseOpts);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    // Called twice: initial attempt + one retry
    expect(globalFetchSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    globalFetchSpy.mockRestore();
  });

  it("retries once on an HTTP 5xx, then succeeds on the second attempt", async () => {
    process.env.SLACK_BOT_TOKEN = TEST_TOKEN;
    vi.useFakeTimers();

    const globalFetchSpy = vi
      .spyOn(globalThis, "fetch")
      // First attempt: transient 5xx (retryable).
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: vi.fn(),
      } as unknown as Response)
      // Second attempt: success — the retried result must be the one honored.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ ok: true, ts: "111.222" }),
      } as unknown as Response);

    const promise = notifySlack(baseOpts);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    // Exactly two attempts: the 5xx retried once, then stopped on success
    // (a third call would mean the success result was not honored).
    expect(globalFetchSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    globalFetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// buildAlertText tests
// ---------------------------------------------------------------------------

describe("buildAlertText", () => {
  it("includes route, message, and correlationId in output", () => {
    const text = buildAlertText({
      route: "test-route",
      message: "something broke",
      correlationId: "ts=2026-01-01T00:00:00.000Z",
    });

    expect(text).toContain("test-route");
    expect(text).toContain("something broke");
    expect(text).toContain("ts=2026-01-01T00:00:00.000Z");
  });

  it("includes error category lines when counters have errored > 0", () => {
    const text = buildAlertText({
      route: "cleanup",
      message: "errors found",
      correlationId: "sha=abc12345",
      counters: {
        "ttl-expired": { kept: 0, dropped: 0, errored: 3 },
        orphan: { kept: 0, dropped: 0, errored: 0 },
        "orphan-branch": { kept: 0, dropped: 0, errored: 0 },
        "pr-closed": { kept: 0, dropped: 0, errored: 0 },
        registryReadErrored: 0,
      },
    });

    expect(text).toContain("errored=3 in ttl-expired");
  });

  it("omits error lines when all counters are zero", () => {
    const text = buildAlertText({
      route: "cleanup",
      message: "no errors",
      correlationId: "sha=abc12345",
      counters: {
        "ttl-expired": { kept: 5, dropped: 5, errored: 0 },
        orphan: { kept: 0, dropped: 0, errored: 0 },
        "orphan-branch": { kept: 0, dropped: 0, errored: 0 },
        "pr-closed": { kept: 0, dropped: 0, errored: 0 },
        registryReadErrored: 0,
      },
    });

    expect(text).not.toContain("*Errors:*");
  });

  it("includes orphan-branch in error lines when orphan-branch has errored > 0", () => {
    const text = buildAlertText({
      route: "cleanup",
      message: "orphan-branch errors found",
      correlationId: "sha=abc12345",
      counters: {
        "ttl-expired": { kept: 0, dropped: 0, errored: 0 },
        orphan: { kept: 0, dropped: 0, errored: 0 },
        "orphan-branch": { kept: 0, dropped: 0, errored: 2 },
        "pr-closed": { kept: 0, dropped: 0, errored: 0 },
        registryReadErrored: 0,
      },
    });

    expect(text).toContain("orphan-branch");
    expect(text).toContain("errored=2 in orphan-branch");
  });

  it("includes all errored category names when multiple categories have errored > 0", () => {
    const text = buildAlertText({
      route: "cleanup",
      message: "multiple category errors",
      correlationId: "sha=abc12345",
      counters: {
        "ttl-expired": { kept: 0, dropped: 0, errored: 4 },
        orphan: { kept: 0, dropped: 0, errored: 0 },
        "orphan-branch": { kept: 0, dropped: 0, errored: 5 },
        "pr-closed": { kept: 0, dropped: 0, errored: 0 },
        registryReadErrored: 0,
      },
    });

    expect(text).toContain("errored=4 in ttl-expired");
    expect(text).toContain("errored=5 in orphan-branch");
  });
});

// ---------------------------------------------------------------------------
// buildCorrelationId tests
// ---------------------------------------------------------------------------

describe("buildCorrelationId", () => {
  afterEach(() => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
  });

  it("uses deployment ID when VERCEL_DEPLOYMENT_ID is set", () => {
    process.env.VERCEL_DEPLOYMENT_ID = "dpl-abc123";
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    const id = buildCorrelationId();
    expect(id).toBe("deployment=dpl-abc123");
  });

  it("includes sha when both VERCEL_DEPLOYMENT_ID and VERCEL_GIT_COMMIT_SHA are set", () => {
    process.env.VERCEL_DEPLOYMENT_ID = "dpl-abc123";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";

    const id = buildCorrelationId();
    expect(id).toBe("deployment=dpl-abc123 sha=abcdef12");
  });

  it("uses sha prefix when only VERCEL_GIT_COMMIT_SHA is set", () => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";

    const id = buildCorrelationId();
    expect(id).toBe("sha=abcdef12");
  });

  it("falls back to ts= prefix when no Vercel env vars are set", () => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    const id = buildCorrelationId();
    expect(id).toMatch(CORRELATION_ID_REGEX);
  });
});
