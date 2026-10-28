import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpServiceErrorCode } from "../errors";
import { jsonBody } from "../json-body";

const bodySchema = z.strictObject({ name: z.string().min(1) });

function appWith(options?: Parameters<typeof jsonBody>[1]) {
  const app = new Hono();
  app.post("/j", jsonBody(bodySchema, options), (c) => {
    const { name } = c.req.valid("json");
    return c.json({ name });
  });
  return app;
}

const post = (app: Hono, body: string, contentType?: string) =>
  app.request("/j", {
    method: "POST",
    body,
    headers: contentType === undefined ? {} : { "content-type": contentType },
  });

const INVALID_BODY = { code: HttpServiceErrorCode.InvalidBody };
const VALID = JSON.stringify({ name: "a" });

describe("jsonBody", () => {
  it("hands the handler the validated body", async () => {
    const response = await post(appWith(), VALID, "application/json");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "a" });
  });

  it.each([
    ["a body that is not JSON", "{not json"],
    ["a body the schema refuses", JSON.stringify({ name: "" })],
  ])("answers %s 400 invalid_body", async (_label, body) => {
    const response = await post(appWith(), body, "application/json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(INVALID_BODY);
  });

  it.each([
    ["text/plain", "text/plain"],
    ["no content-type", undefined],
  ])(
    "refuses a valid JSON body sent as %s by default",
    async (_label, type) => {
      const response = await post(appWith(), VALID, type);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID_BODY);
    }
  );

  it("parses a valid JSON body sent as text/plain with anyContentType", async () => {
    const response = await post(
      appWith({ anyContentType: true }),
      VALID,
      "text/plain"
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "a" });
  });

  it("answers an empty 400 when code is null", async () => {
    const response = await post(
      appWith({ code: null }),
      JSON.stringify({ name: "" }),
      "application/json"
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});
