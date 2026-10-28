import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OtlpExportKind } from "../src/main/otlp/proto-descriptor.js";
import {
  type NormalizedOtlpExport,
  OtlpHarness,
  OtlpHttpReceiver,
  type OtlpHttpReceiverOptions,
} from "../src/main/telemetry/otlp-http-receiver.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  DEFAULT_OTLP_RECEIVER_PORT,
  OtlpReceiverUnavailableReason,
} from "../src/main/telemetry/otlp-receiver-state.js";
import { deferred } from "./deferred.js";
import {
  encodeAttributes,
  encodeLogRecords,
  encodePayload,
  encodeSpans,
  PROTOBUF_CONTENT_TYPE,
} from "./helpers/claude-code-otel-fixtures.js";

type Reply = { status: number; body: string; connection: string | undefined };

const receivers: OtlpHttpReceiver[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const receiver of receivers.splice(0)) {
    await receiver.stop();
  }
});

async function startReceiver(options: OtlpHttpReceiverOptions = {}) {
  const createServer = vi.spyOn(http, "createServer");
  const receiver = new OtlpHttpReceiver({ port: 0, ...options });
  receivers.push(receiver);
  const state = await receiver.start();
  const server = createServer.mock.results[0]?.value as http.Server;
  createServer.mockRestore();
  if (!state.available) {
    throw new Error("receiver did not bind");
  }
  return { receiver, port: state.port, server };
}

function post(
  port: number,
  pathname: string,
  body: Buffer,
  options: { host?: string; declaredLength?: number } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      {
        hostname: DEFAULT_OTLP_RECEIVER_HOST,
        port,
        path: pathname,
        method: "POST",
        agent: false,
        headers: {
          "Content-Length": options.declaredLength ?? body.length,
          "Content-Type": PROTOBUF_CONTENT_TYPE,
          ...(options.host ? { Host: options.host } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            connection: response.headers.connection,
          });
          request.destroy();
        });
      }
    );
    request.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
    if (options.declaredLength === undefined) {
      request.end(body);
    } else {
      request.write(body);
    }
  });
}

function claudeLogs(): Buffer {
  return encodeLogRecords([{ body: { stringValue: "claude line" } }]);
}

describe("OtlpHttpReceiver lifecycle edges", () => {
  it("reports the default port as not started before start()", () => {
    expect(new OtlpHttpReceiver().getState()).toEqual({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.NotStarted,
    });
  });

  it("returns the running state without creating a second server when started twice", async () => {
    const createServer = vi.spyOn(http, "createServer");
    const receiver = new OtlpHttpReceiver({ port: 0 });
    receivers.push(receiver);
    const first = await receiver.start();
    const second = await receiver.start();
    expect(second).toBe(first);
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(receiver.getBoundAddress()?.port).toBe(
      first.available ? first.port : -1
    );
  });

  it("names the default port when it is already in use", async () => {
    const listenPorts: unknown[] = [];
    vi.spyOn(http, "createServer").mockImplementationOnce(((
      listener: http.RequestListener
    ) => {
      const server = new http.Server(listener);
      server.listen = ((...args: unknown[]) => {
        listenPorts.push(args[0], args[1]);
        queueMicrotask(() =>
          server.emit(
            "error",
            Object.assign(new Error("in use"), { code: "EADDRINUSE" })
          )
        );
        return server;
      }) as typeof server.listen;
      return server;
    }) as typeof http.createServer);
    const bindErrors: string[] = [];
    const receiver = new OtlpHttpReceiver({
      onBindError: (reason) => bindErrors.push(reason),
    });
    receivers.push(receiver);
    expect(await receiver.start()).toEqual({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.BindFailed,
    });
    expect(listenPorts).toEqual([
      DEFAULT_OTLP_RECEIVER_PORT,
      DEFAULT_OTLP_RECEIVER_HOST,
    ]);
    expect(bindErrors).toEqual([
      `OTLP receiver port ${DEFAULT_OTLP_RECEIVER_PORT} is already in use.`,
    ]);
  });

  it("reports a bind error other than EADDRINUSE with its message", async () => {
    vi.spyOn(http, "createServer").mockImplementationOnce(((
      listener: http.RequestListener
    ) => {
      const server = new http.Server(listener);
      server.listen = ((..._args: unknown[]) => {
        queueMicrotask(() =>
          server.emit(
            "error",
            Object.assign(new Error("permission denied"), { code: "EACCES" })
          )
        );
        return server;
      }) as typeof server.listen;
      return server;
    }) as typeof http.createServer);
    const logs: string[] = [];
    const bindErrors: string[] = [];
    const receiver = new OtlpHttpReceiver({
      port: 0,
      log: (message) => logs.push(message),
      onBindError: (reason) => bindErrors.push(reason),
    });
    receivers.push(receiver);
    expect(await receiver.start()).toEqual({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 0,
      reason: OtlpReceiverUnavailableReason.BindFailed,
    });
    expect(logs).toEqual(["OTLP receiver bind failed: permission denied"]);
    expect(bindErrors).toEqual([
      "OTLP receiver bind failed: permission denied",
    ]);
    expect(receiver.getBoundAddress()).toBeNull();
  });
});

describe("OtlpHttpReceiver Host admission", () => {
  it("accepts bracketed IPv6 loopback authorities and refuses a bracketed non-loopback one", async () => {
    const exports: NormalizedOtlpExport[] = [];
    const logs: string[] = [];
    const { port } = await startReceiver({
      log: (message) => logs.push(message),
      onClaudeExport: (payload) => {
        exports.push(payload);
      },
    });
    expect(
      (await post(port, "/v1/logs", claudeLogs(), { host: "[::1]:4318" }))
        .status
    ).toBe(200);
    // pins current behavior; looks odd because an unterminated "[::1" authority is read as loopback
    expect(
      (await post(port, "/v1/logs", claudeLogs(), { host: "[::1" })).status
    ).toBe(200);
    const refused = await post(port, "/v1/logs", claudeLogs(), {
      host: "[2001:db8::1]:4318",
    });
    expect(refused).toMatchObject({ status: 403, body: "forbidden" });
    expect(logs).toContain(
      'OTLP receiver refused a request: non-loopback Host header "[2001:db8::1]:4318"'
    );
    expect(exports).toHaveLength(2);
  });

  it("accepts a localhost authority with and without a port", async () => {
    const exports: NormalizedOtlpExport[] = [];
    const { port } = await startReceiver({
      onClaudeExport: (payload) => {
        exports.push(payload);
      },
    });
    for (const host of ["localhost:4318", "localhost"]) {
      expect(
        (await post(port, "/v1/logs", claudeLogs(), { host })).status
      ).toBe(200);
    }
    expect(exports).toHaveLength(2);
  });
});

describe("OtlpHttpReceiver export normalization", () => {
  it("summarizes a log severity number, an unnamed span, and skips attributes without a key or scalar", async () => {
    const exports: NormalizedOtlpExport[] = [];
    const { port } = await startReceiver({
      onClaudeExport: (payload) => {
        exports.push(payload);
      },
    });
    const logs = encodePayload(OtlpExportKind.Logs, {
      resourceLogs: [
        {
          resource: {
            attributes: [
              ...encodeAttributes({ "service.name": "claude-code" }),
              { key: "list.attr", value: { arrayValue: { values: [] } } },
              { key: "", value: { stringValue: "keyless" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                { severityNumber: 9, body: { stringValue: "numbered" } },
                { severityText: "INFO", body: { stringValue: "texted" } },
              ],
            },
          ],
        },
      ],
    });
    expect((await post(port, "/v1/logs", logs)).status).toBe(200);
    expect((await post(port, "/v1/traces", encodeSpans([{}]))).status).toBe(
      200
    );
    const [logExport, traceExport] = exports;
    expect(logExport?.resourceAttributes).toStrictEqual([
      { "service.name": "claude-code" },
    ]);
    expect(logExport?.logSummaries).toStrictEqual([
      { severityNumber: 9, body: "numbered" },
      { severityText: "INFO", body: "texted" },
    ]);
    expect(traceExport?.spanSummaries).toStrictEqual([{ name: "" }]);
  });

  it("caps each unknown-export diagnostic list at ten values and counts the rest", async () => {
    const logs: string[] = [];
    const unknown: string[] = [];
    const { port } = await startReceiver({
      log: (message) => logs.push(message),
      onUnknownExport: (payload) => {
        unknown.push(payload.harness);
      },
    });
    const attributes = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`attr.${index}`, `v${index}`])
    );
    const body = encodePayload(OtlpExportKind.Logs, {
      resourceLogs: [
        {
          resource: { attributes: encodeAttributes(attributes) },
          scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }],
        },
      ],
    });
    expect((await post(port, "/v1/logs", body)).status).toBe(200);
    const shown = Array.from(
      { length: 10 },
      (_, index) => `attr.${index}=v${index}`
    );
    expect(logs).toContain(
      `OTLP receiver dropped unknown-harness logs export. scopes=[] resourceAttributes=[${shown.join(", ")}] (+2 more) names=[]`
    );
    expect(unknown).toEqual([OtlpHarness.Unknown]);
  });
});

describe("OtlpHttpReceiver body read failures", () => {
  it("answers 413 and closes the connection for a body over the limit", async () => {
    const exports: NormalizedOtlpExport[] = [];
    const { port } = await startReceiver({
      maxBodyBytes: 4,
      onClaudeExport: (payload) => {
        exports.push(payload);
      },
    });
    expect(await post(port, "/v1/logs", Buffer.from("12345"))).toEqual({
      status: 413,
      body: "payload too large",
      connection: "close",
    });
    expect(exports).toEqual([]);
  });

  it("answers 408 and closes the connection when the body read times out", async () => {
    const exports: NormalizedOtlpExport[] = [];
    const { port, server } = await startReceiver({
      onClaudeExport: (payload) => {
        exports.push(payload);
      },
    });
    server.once("request", (req: http.IncomingMessage) => {
      req.emit("timeout");
    });
    const reply = await post(port, "/v1/logs", Buffer.from([0x0a]), {
      declaredLength: 64,
    });
    expect(reply).toEqual({
      status: 408,
      body: "request timeout",
      connection: "close",
    });
    expect(exports).toEqual([]);
  });

  it("answers 400 and keeps the connection open when the request stream errors", async () => {
    const { port, server } = await startReceiver({
      onClaudeExport: () => undefined,
    });
    server.once("request", (req: http.IncomingMessage) => {
      req.emit("error", new Error("stream broke"));
    });
    const reply = await post(port, "/v1/logs", Buffer.from([0x0a]), {
      declaredLength: 64,
    });
    expect(reply).toEqual({
      status: 400,
      body: "bad request",
      connection: "keep-alive",
    });
  });

  it("ignores a timeout that fires after the body already ended", async () => {
    const exports: NormalizedOtlpExport[] = [];
    const { port, server } = await startReceiver({
      onClaudeExport: (payload) => {
        exports.push(payload);
      },
    });
    server.once("request", (req: http.IncomingMessage) => {
      req.on("end", () => {
        req.emit("timeout");
      });
    });
    const reply = await post(port, "/v1/logs", claudeLogs());
    expect(reply.status).toBe(200);
    expect(exports).toHaveLength(1);
  });
});

describe("OtlpHttpReceiver dispatch queue", () => {
  it("restarts draining for an export queued while the previous drain was finishing", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const { receiver, port, server } = await startReceiver({
      onClaudeExport: (payload) => {
        seen.push(String(payload.logSummaries[0]?.body));
        return seen.length === 1 ? gate.promise : undefined;
      },
    });
    const first = encodeLogRecords([{ body: { stringValue: "first" } }]);
    const second = encodeLogRecords([{ body: { stringValue: "second" } }]);
    expect((await post(port, "/v1/logs", first)).status).toBe(200);
    expect(seen).toEqual(["first"]);
    // Release the first callback in the same tick the second body ends, ahead
    // of the receiver's own end handler, so the drain loop sees an empty queue
    // just before the second export is pushed.
    server.once("request", (req: http.IncomingMessage) => {
      req.prependListener("end", () => gate.resolve());
    });
    expect((await post(port, "/v1/logs", second)).status).toBe(200);
    await receiver.stop();
    expect(seen).toEqual(["first", "second"]);
  });

  it("stops without a deadline warning once every queued export has run", async () => {
    const logs: string[] = [];
    const seen: NormalizedOtlpExport[] = [];
    const { receiver, port } = await startReceiver({
      log: (message) => logs.push(message),
      onClaudeExport: (payload) => {
        seen.push(payload);
      },
    });
    expect((await post(port, "/v1/logs", claudeLogs())).status).toBe(200);
    await receiver.stop();
    expect(seen).toHaveLength(1);
    expect(
      logs.filter((line) => line.includes("awaiting persistence"))
    ).toEqual([]);
  });

  it("gives up waiting at the drain deadline and reports what is still queued", async () => {
    const logs: string[] = [];
    const wedged = deferred();
    let calls = 0;
    const { receiver, port } = await startReceiver({
      log: (message) => logs.push(message),
      onClaudeExport: () => {
        calls += 1;
        return wedged.promise;
      },
    });
    expect((await post(port, "/v1/logs", claudeLogs())).status).toBe(200);
    expect((await post(port, "/v1/logs", claudeLogs())).status).toBe(200);
    expect(calls).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = receiver.stop();
    for (let spins = 0; vi.getTimerCount() === 0; spins += 1) {
      if (spins > 10_000) {
        throw new Error("drain deadline timer was never armed");
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(logs).toContain(
      "OTLP receiver stopped with 1 export(s) still awaiting persistence."
    );
    wedged.resolve();
  });
});
