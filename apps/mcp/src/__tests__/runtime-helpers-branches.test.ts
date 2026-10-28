import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTemporarilyUnavailable } from "../oauth-http.js";
import { readJsonBody, readRequestBody } from "../request-body.js";
import { registerCreateInlineImageAttachment } from "../tools/create-inline-image-attachment.js";
import { idOrSlugRequiredMessage } from "../tools/tool-utils.js";
import { withTimeout } from "../with-timeout.js";
import { asServerResponse, createMockResponse } from "./fixtures/mock-http.js";
import { createToolHarness } from "./fixtures/tool-harness.js";

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

function streamRequest(chunks: string[], headers: Record<string, string>) {
  return Object.assign(Readable.from(chunks, { objectMode: true }), {
    headers,
  }) as never;
}

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "arms no timer and resolves to the wrapped value for timeout %s",
    async (timeoutMs) => {
      vi.useFakeTimers();

      const result = withTimeout(Promise.resolve("value"), timeoutMs, "ctx");

      expect(vi.getTimerCount()).toBe(0);
      await expect(result).resolves.toBe("value");
    }
  );

  it("rejects with a TimeoutError naming the context when the timer wins", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 50, "lookup");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      message: "lookup timed out after 50ms",
    });

    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });
});

describe("request body readers", () => {
  it("concatenates non-Buffer string chunks", async () => {
    const body = await readRequestBody(streamRequest(["ab", "c"], {}));

    expect(body).toBe("abc");
  });

  it("returns null without reading when the request has no content-type header", async () => {
    const req = streamRequest(['{"a":1}'], {});

    expect(await readJsonBody(req)).toBeNull();
    expect(await readRequestBody(req)).toBe('{"a":1}');
  });
});

describe("sendTemporarilyUnavailable", () => {
  it("omits Retry-After when no retry hint is given", () => {
    const res = createMockResponse();

    sendTemporarilyUnavailable(asServerResponse(res), "busy");

    expect(res.statusCode).toBe(503);
    expect(res.headers).not.toHaveProperty("Retry-After");
    expect(JSON.parse(res.body)).toEqual({
      error: "temporarily_unavailable",
      error_description: "busy",
    });
  });

  it("sets Retry-After from the hint", () => {
    const res = createMockResponse();

    sendTemporarilyUnavailable(asServerResponse(res), "busy", 30);

    expect(res.headers["Retry-After"]).toBe("30");
  });
});

describe("idOrSlugRequiredMessage", () => {
  it("ends at the example list when no discovery hint is given", () => {
    expect(idOrSlugRequiredMessage("document", ["PRD-7", "ISS-42"])).toBe(
      "A document UUID or user-facing slug is required (e.g. PRD-7, ISS-42)."
    );
  });
});

describe("create-inline-image-attachment response validation", () => {
  it("fails the tool call when the API response carries no attachment id anywhere", async () => {
    const post = vi.fn().mockResolvedValue({ attachment: { filename: "x" } });
    const handler = createToolHarness(registerCreateInlineImageAttachment, {
      post,
    } as never);

    const result = await handler({
      entityId: "DOC-1",
      filename: "input.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "API response missing attachmentId"
    );
  });
});
