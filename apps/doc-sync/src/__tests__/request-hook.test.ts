import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NodeBindings } from "@repo/http-service/node-listener";
import { log } from "@repo/observability/log";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOC_SYNC_HTTP_REQUEST_FAULT_EVENT,
  honoRequestHook,
} from "../http/request-hook";

let server: Server | undefined;
let outcomes: Promise<PromiseSettledResult<void>>[];

/** Serves `app` through the hook as Hocuspocus would, recording how each call settles. */
async function serve(app: Hono<{ Bindings: NodeBindings }>): Promise<string> {
  const hook = honoRequestHook(app);
  outcomes = [];
  server = createServer((request, response) => {
    outcomes.push(
      hook({ request, response }).then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason })
      )
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe("honoRequestHook", () => {
  it("answers through the app, then rejects with no value", async () => {
    const app = new Hono<{ Bindings: NodeBindings }>();
    app.get("/ok", (c) => c.json({ ok: true }));
    const base = await serve(app);

    const response = await fetch(`${base}/ok`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await Promise.all(outcomes)).toEqual([
      { status: "rejected", reason: undefined },
    ]);
  });

  it("answers a throwing app 500 with no welcome text, and still rejects with no value", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const app = new Hono<{ Bindings: NodeBindings }>();
    app.get("/throw", () => {
      throw new Error("boom");
    });
    app.onError((cause) => {
      throw cause;
    });
    const base = await serve(app);

    const response = await fetch(`${base}/throw`);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(await Promise.all(outcomes)).toEqual([
      { status: "rejected", reason: undefined },
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: DOC_SYNC_HTTP_REQUEST_FAULT_EVENT })
    );
  });
});
