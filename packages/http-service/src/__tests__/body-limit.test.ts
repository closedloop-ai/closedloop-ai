import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { internalBodyLimit } from "../body-limit";
import { HttpServiceErrorCode } from "../errors";

const MAX_BYTES = 8;

function appWith(limit: Parameters<typeof internalBodyLimit>[0]) {
  const app = new Hono();
  app.post("/b", internalBodyLimit(limit), async (c) =>
    c.json({ bytes: (await c.req.text()).length })
  );
  return app;
}

const post = (app: Hono, body: BodyInit, headers: Record<string, string>) =>
  app.request("/b", { method: "POST", body, headers });

function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
      controller.close();
    },
  });
}

describe("internalBodyLimit", () => {
  it("passes a body at the cap", async () => {
    const response = await post(
      appWith({ maxBytes: MAX_BYTES }),
      "x".repeat(MAX_BYTES),
      { "content-length": String(MAX_BYTES) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: MAX_BYTES });
  });

  it("refuses a body one byte over the cap 413 payload_too_large", async () => {
    const response = await post(
      appWith({ maxBytes: MAX_BYTES }),
      "x".repeat(MAX_BYTES + 1),
      { "content-length": String(MAX_BYTES + 1) }
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.PayloadTooLarge,
    });
  });

  it("refuses a chunked body with no content-length once it passes the cap", async () => {
    const request = new Request("http://localhost/b", {
      method: "POST",
      body: chunked("x".repeat(MAX_BYTES + 1)),
      duplex: "half",
    } as RequestInit);

    expect(request.headers.get("content-length")).toBeNull();
    const response = await appWith({ maxBytes: MAX_BYTES }).request(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.PayloadTooLarge,
    });
  });

  it("answers the given status with an empty body when code is null", async () => {
    const response = await post(
      appWith({ maxBytes: MAX_BYTES, status: 400, code: null }),
      "x".repeat(MAX_BYTES + 1),
      { "content-length": String(MAX_BYTES + 1) }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});
