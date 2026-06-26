import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { AgentHookListener } from "../src/main/agent-monitor-listener.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  type NormalizedOtlpExport,
  OtlpHttpReceiver,
} from "../src/main/otlp-http-receiver.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  OtlpReceiverUnavailableReason,
} from "../src/main/otlp-receiver-state.js";

const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
const JSON_CONTENT_TYPE = "application/json";
const TEXT_CONTENT_TYPE = "text/plain";
const DIAGNOSTIC_SCOPES_RE = /scopes=\[mystery\.instrumentation\]/;
const DIAGNOSTIC_SERVICE_NAME_RE = /service\.name=mystery-cli/;
const DIAGNOSTIC_NAMES_RE = /names=\[do_work\]/;

type ResponsePayload = {
  body: Buffer;
  contentType: string;
  status: number;
};

test("OTLP receiver binds only strict IPv4 loopback", async () => {
  const receiver = new OtlpHttpReceiver({ port: 0 });
  const state = await receiver.start();

  try {
    assert.equal(state.available, true);
    assert.equal(state.host, DEFAULT_OTLP_RECEIVER_HOST);
    assert.equal(
      receiver.getBoundAddress()?.address,
      DEFAULT_OTLP_RECEIVER_HOST
    );
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver rejects non-loopback host overrides without binding", async () => {
  const bindErrors: string[] = [];
  const receiver = new OtlpHttpReceiver({
    host: "0.0.0.0",
    port: 0,
    onBindError: (reason) => bindErrors.push(reason),
  });

  const state = await receiver.start();

  assert.deepEqual(state, {
    available: false,
    host: DEFAULT_OTLP_RECEIVER_HOST,
    port: 0,
    reason: OtlpReceiverUnavailableReason.InvalidHost,
  });
  assert.equal(receiver.getBoundAddress(), null);
  assert.equal(bindErrors.length, 1);
});

test("OTLP receiver accepts valid metrics, logs, and traces protobuf exports", async () => {
  const claudeExports: NormalizedOtlpExport[] = [];
  const codexExports: NormalizedOtlpExport[] = [];
  const logs: string[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    log: (message) => logs.push(message),
    onClaudeExport: (payload) => claudeExports.push(payload),
    onCodexExport: (payload) => codexExports.push(payload),
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const metrics = await postOtlp(
      state.port,
      "/v1/metrics",
      encodeMetricsPayload({ "service.name": "claude-code" })
    );
    const logsResponse = await postOtlp(
      state.port,
      "/v1/logs",
      encodeLogsPayload({ "service.name": "codex" })
    );
    const traces = await postOtlp(
      state.port,
      "/v1/traces",
      encodeTracesPayload({ "service.name": "unknown-exporter" })
    );

    assert.equal(metrics.status, 200);
    assert.equal(logsResponse.status, 200);
    assert.equal(traces.status, 200);
    assert.equal(metrics.contentType, PROTOBUF_CONTENT_TYPE);
    assert.equal(metrics.body.length, 0);
    assert.equal(claudeExports.length, 1);
    assert.equal(claudeExports[0]?.kind, OtlpExportKind.Metrics);
    assert.deepEqual(claudeExports[0]?.metricNames, ["claude_code.cost.usage"]);
    assert.equal(codexExports.length, 1);
    assert.equal(codexExports[0]?.kind, OtlpExportKind.Logs);
    assert.equal(codexExports[0]?.logSummaries[0]?.body, "codex log line");
    assert.equal(
      logs.some((message) => message.includes("unknown-harness traces")),
      true
    );
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver returns precise HTTP validation statuses", async () => {
  const dispatches = {
    claude: 0,
    codex: 0,
    unknown: 0,
  };
  const receiver = new OtlpHttpReceiver({
    maxBodyBytes: 4,
    port: 0,
    onClaudeExport: () => {
      dispatches.claude += 1;
    },
    onCodexExport: () => {
      dispatches.codex += 1;
    },
    onUnknownExport: () => {
      dispatches.unknown += 1;
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    assert.equal((await request(state.port, "GET", "/v1/logs")).status, 405);
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
    assert.equal(
      (await request(state.port, "POST", "/v1/unknown")).status,
      404
    );
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/logs",
          Buffer.from("{}"),
          TEXT_CONTENT_TYPE
        )
      ).status,
      415
    );
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/logs",
          Buffer.from("{}"),
          JSON_CONTENT_TYPE
        )
      ).status,
      415
    );
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/logs",
          Buffer.from([0xff]),
          PROTOBUF_CONTENT_TYPE
        )
      ).status,
      400
    );
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/logs",
          Buffer.from("12345"),
          PROTOBUF_CONTENT_TYPE
        )
      ).status,
      413
    );
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver rejects oversized streaming bodies before request end", {
  timeout: 2000,
}, async () => {
  const dispatches = {
    claude: 0,
    codex: 0,
    unknown: 0,
  };
  const receiver = new OtlpHttpReceiver({
    maxBodyBytes: 4,
    port: 0,
    onClaudeExport: () => {
      dispatches.claude += 1;
    },
    onCodexExport: () => {
      dispatches.codex += 1;
    },
    onUnknownExport: () => {
      dispatches.unknown += 1;
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);
  const heldRequest = openHeldOtlpRequest(state.port, "/v1/logs");

  try {
    await heldRequest.connected;
    heldRequest.write(Buffer.from("12345"));
    const response = await heldRequest.response;

    assert.equal(response.status, 413);
    assert.deepEqual(dispatches, { claude: 0, codex: 0, unknown: 0 });
  } finally {
    heldRequest.destroy();
    await receiver.stop();
  }
});

test("OTLP receiver stop force-closes active held-body requests", {
  timeout: 2000,
}, async () => {
  const receiver = new OtlpHttpReceiver({ port: 0 });
  const state = await receiver.start();
  assert.equal(state.available, true);
  const heldRequest = openHeldOtlpRequest(state.port, "/v1/logs");
  const ignoredResponse = heldRequest.response.catch(() => undefined);
  await heldRequest.connected;
  heldRequest.write(Buffer.from([0]));

  try {
    await receiver.stop();
    assert.equal(receiver.getState().available, false);
  } finally {
    heldRequest.destroy();
    await ignoredResponse;
    await receiver.stop();
  }
});

test("OTLP receiver treats Codex-shaped non-identifying payloads as unknown", async () => {
  const claudeExports: NormalizedOtlpExport[] = [];
  const codexExports: NormalizedOtlpExport[] = [];
  const unknownKinds: OtlpExportKind[] = [];
  const logs: string[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    log: (message) => logs.push(message),
    onClaudeExport: (payload) => claudeExports.push(payload),
    onCodexExport: (payload) => codexExports.push(payload),
    onUnknownExport: (payload) => {
      unknownKinds.push(payload.kind);
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const response = await postOtlp(
      state.port,
      "/v1/logs",
      encodeLogsPayload({
        "telemetry.sdk.name": "opentelemetry",
        "process.command": "mcp-server",
      })
    );

    assert.equal(response.status, 200);
    await waitFor(() => unknownKinds.length === 1);
    assert.deepEqual(unknownKinds, [OtlpExportKind.Logs]);
    assert.deepEqual(claudeExports, []);
    assert.deepEqual(codexExports, []);
    assert.equal(
      logs.some((message) => message.includes("unknown-harness logs")),
      true
    );
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver classifies codex-app-server logs and traces as Codex", async () => {
  const codexExports: NormalizedOtlpExport[] = [];
  const unknownKinds: OtlpExportKind[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onCodexExport: (payload) => codexExports.push(payload),
    onUnknownExport: (payload) => {
      unknownKinds.push(payload.kind);
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const logsResponse = await postOtlp(
      state.port,
      "/v1/logs",
      encodeLogsPayload({ "service.name": "codex-app-server" })
    );
    const tracesResponse = await postOtlp(
      state.port,
      "/v1/traces",
      encodeTracesPayload({ "service.name": "codex-app-server" })
    );

    assert.equal(logsResponse.status, 200);
    assert.equal(tracesResponse.status, 200);
    await waitFor(() => codexExports.length === 2);
    assert.deepEqual(
      codexExports.map((payload) => payload.kind).sort(),
      [OtlpExportKind.Logs, OtlpExportKind.Traces].sort()
    );
    assert.deepEqual(unknownKinds, []);
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver logs identity-bearing diagnostics for unknown-harness exports", async () => {
  const logs: string[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    log: (message) => logs.push(message),
    onUnknownExport: () => {
      // intentionally no-op: data is dropped, we only assert the diagnostic log
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const response = await postOtlp(
      state.port,
      "/v1/traces",
      encodePayload(OtlpExportKind.Traces, {
        resourceSpans: [
          {
            resource: {
              attributes: encodeAttributes({ "service.name": "mystery-cli" }),
            },
            scopeSpans: [
              {
                scope: { name: "mystery.instrumentation" },
                spans: [{ name: "do_work" }],
              },
            ],
          },
        ],
      })
    );

    assert.equal(response.status, 200);
    await waitFor(() =>
      logs.some((message) => message.includes("unknown-harness traces"))
    );
    const diagnostic = logs.find((message) =>
      message.includes("unknown-harness traces")
    );
    assert.ok(diagnostic);
    assert.match(diagnostic, DIAGNOSTIC_SCOPES_RE);
    assert.match(diagnostic, DIAGNOSTIC_SERVICE_NAME_RE);
    assert.match(diagnostic, DIAGNOSTIC_NAMES_RE);
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver does not classify substring-only harness identifiers", async () => {
  const claudeExports: NormalizedOtlpExport[] = [];
  const codexExports: NormalizedOtlpExport[] = [];
  const unknownKinds: OtlpExportKind[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onClaudeExport: (payload) => claudeExports.push(payload),
    onCodexExport: (payload) => codexExports.push(payload),
    onUnknownExport: (payload) => {
      unknownKinds.push(payload.kind);
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const response = await postOtlp(
      state.port,
      "/v1/metrics",
      encodePayload(OtlpExportKind.Metrics, {
        resourceMetrics: [
          {
            resource: {
              attributes: encodeAttributes({
                "plugin.name": "my_codex_cli_helper",
              }),
            },
            scopeMetrics: [
              {
                metrics: [{ name: "my_claude_code_plugin_cost" }],
              },
            ],
          },
        ],
      })
    );

    assert.equal(response.status, 200);
    await waitFor(() => unknownKinds.length === 1);
    assert.deepEqual(unknownKinds, [OtlpExportKind.Metrics]);
    assert.deepEqual(claudeExports, []);
    assert.deepEqual(codexExports, []);
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver acknowledges before writer callbacks settle", async () => {
  let releaseCallback: (() => void) | undefined;
  let callbackStarted = false;
  let callbackSettled = false;
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onClaudeExport: () => {
      callbackStarted = true;
      return new Promise<void>((resolve) => {
        releaseCallback = () => {
          callbackSettled = true;
          resolve();
        };
      });
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const response = await postOtlp(
      state.port,
      "/v1/metrics",
      encodeMetricsPayload({ "service.name": "claude_code" })
    );

    assert.equal(response.status, 200);
    assert.equal(callbackStarted, true);
    assert.equal(callbackSettled, false);
    releaseCallback?.();
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver logs callback rejection after successful response", async () => {
  const logs: string[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    log: (message) => logs.push(message),
    onCodexExport: () =>
      Promise.reject(new Error("payload body: user prompt secret")),
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const response = await postOtlp(
      state.port,
      "/v1/logs",
      encodeLogsPayload({ "service.name": "codex" })
    );
    assert.equal(response.status, 200);
    await waitFor(() =>
      logs.some((message) => message.includes("callback failed"))
    );
    assert.equal(
      logs.some((message) => message.includes("user prompt secret")),
      false
    );
  } finally {
    await receiver.stop();
  }
});

test("OTLP receiver bind failure is unavailable and non-throwing", async () => {
  const first = new OtlpHttpReceiver({ port: 0 });
  const firstState = await first.start();
  assert.equal(firstState.available, true);
  const second = new OtlpHttpReceiver({ port: firstState.port });

  try {
    const secondState = await second.start();
    assert.deepEqual(secondState, {
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: firstState.port,
      reason: OtlpReceiverUnavailableReason.BindFailed,
    });
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("OTLP receiver does not synthesize rows when no request arrives", async () => {
  const claudeExports: NormalizedOtlpExport[] = [];
  const codexExports: NormalizedOtlpExport[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onClaudeExport: (payload) => claudeExports.push(payload),
    onCodexExport: (payload) => codexExports.push(payload),
  });

  await receiver.start();
  await receiver.stop();

  assert.deepEqual(claudeExports, []);
  assert.deepEqual(codexExports, []);
});

test("OTLP receiver coexists with hook listener while callback is pending", async () => {
  let releaseCallback: (() => void) | undefined;
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onClaudeExport: () =>
      new Promise<void>((resolve) => {
        releaseCallback = resolve;
      }),
  });
  const receiverState = await receiver.start();
  assert.equal(receiverState.available, true);
  const hookListener = new AgentHookListener({
    lifecycle: { processEvent: () => true },
    port: 0,
  });
  await hookListener.start();
  const hookUrl = hookListener.getUrl();
  assert.ok(hookUrl);

  try {
    const otlpResponse = await postOtlp(
      receiverState.port,
      "/v1/metrics",
      encodeMetricsPayload({ "service.name": "claude-code" })
    );
    const hookResponse = await requestUrl(
      `${hookUrl}/api/hooks/event`,
      "POST",
      Buffer.from(JSON.stringify({ hook_type: "SessionStart", data: {} })),
      JSON_CONTENT_TYPE
    );

    assert.equal(otlpResponse.status, 200);
    assert.equal(hookResponse.status, 200);
    releaseCallback?.();
  } finally {
    await hookListener.stop();
    await receiver.stop();
  }
});

function encodeMetricsPayload(attributes: Record<string, string>): Buffer {
  return encodePayload(OtlpExportKind.Metrics, {
    resourceMetrics: [
      {
        resource: { attributes: encodeAttributes(attributes) },
        scopeMetrics: [
          {
            metrics: [{ name: "claude_code.cost.usage" }],
          },
        ],
      },
    ],
  });
}

function encodeLogsPayload(attributes: Record<string, string>): Buffer {
  return encodePayload(OtlpExportKind.Logs, {
    resourceLogs: [
      {
        resource: { attributes: encodeAttributes(attributes) },
        scopeLogs: [
          {
            logRecords: [
              {
                severityText: "INFO",
                body: { stringValue: "codex log line" },
              },
            ],
          },
        ],
      },
    ],
  });
}

function encodeTracesPayload(attributes: Record<string, string>): Buffer {
  return encodePayload(OtlpExportKind.Traces, {
    resourceSpans: [
      {
        resource: { attributes: encodeAttributes(attributes) },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.alloc(16, 1),
                spanId: Buffer.alloc(8, 2),
                name: "tool_call",
              },
            ],
          },
        ],
      },
    ],
  });
}

function encodePayload(kind: OtlpExportKind, payload: object): Buffer {
  const type = getOtlpRequestType(kind);
  return Buffer.from(type.encode(type.create(payload)).finish());
}

function encodeAttributes(attributes: Record<string, string>) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function postOtlp(
  port: number,
  path: string,
  body: Buffer
): Promise<ResponsePayload> {
  return request(port, "POST", path, body, PROTOBUF_CONTENT_TYPE);
}

function request(
  port: number,
  method: string,
  path: string,
  body?: Buffer,
  contentType?: string
): Promise<ResponsePayload> {
  return requestUrl(
    `http://${DEFAULT_OTLP_RECEIVER_HOST}:${port}${path}`,
    method,
    body,
    contentType
  );
}

function requestUrl(
  url: string,
  method: string,
  body?: Buffer,
  contentType?: string
): Promise<ResponsePayload> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const requestOptions: http.RequestOptions = {
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method,
      headers:
        body && contentType
          ? {
              "Content-Length": body.length,
              "Content-Type": contentType,
            }
          : undefined,
    };
    const req = http.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          contentType: res.headers["content-type"] ?? "",
          status: res.statusCode ?? 0,
        });
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function openHeldOtlpRequest(
  port: number,
  path: string
): {
  connected: Promise<void>;
  destroy: () => void;
  response: Promise<ResponsePayload>;
  write: (chunk: Buffer) => void;
} {
  let responseRequest: http.ClientRequest | undefined;
  let resolveConnected = (): void => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  const response = new Promise<ResponsePayload>((resolve, reject) => {
    const req = http.request(
      {
        headers: {
          "Content-Type": PROTOBUF_CONTENT_TYPE,
        },
        hostname: DEFAULT_OTLP_RECEIVER_HOST,
        method: "POST",
        path,
        port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            contentType: res.headers["content-type"] ?? "",
            status: res.statusCode ?? 0,
          });
        });
      }
    );
    req.on("socket", (socket) => {
      if (socket.connecting) {
        socket.once("connect", resolveConnected);
        return;
      }
      resolveConnected();
    });
    req.on("error", reject);
    responseRequest = req;
  });
  return {
    connected,
    destroy: () => responseRequest?.destroy(),
    response,
    write: (chunk) => responseRequest?.write(chunk),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met before timeout");
}
