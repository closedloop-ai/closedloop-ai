/**
 * ISS-7352 (whitlockk review) — the OTLP receiver as a WRITE endpoint.
 *
 * Before this ticket the receiver decoded exports and logged them, so who
 * called it barely mattered. It now persists to the local store, which makes
 * two things load-bearing: WHO may reach it (an unauthenticated loopback port
 * is reachable by any page the user is browsing, via DNS rebinding), and what
 * happens to work it has already ACKed but not yet written.
 *
 * Decode, classification, and HTTP validation are the sibling suite,
 * `otlp-http-receiver.test.ts`.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vitest";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  type NormalizedOtlpExport,
  OtlpHttpReceiver,
} from "../src/main/telemetry/otlp-http-receiver.js";
import { DEFAULT_OTLP_RECEIVER_HOST } from "../src/main/telemetry/otlp-receiver-state.js";

const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";

type ResponsePayload = {
  body: Buffer;
  contentType: string;
  status: number;
};

test("ISS-7352: a DNS-rebinding shaped request never reaches the writer", async () => {
  // Since ISS-7352 a Claude export is a WRITE to the local store, so the
  // question this pins is not "what status came back" but "did the callback
  // run". A rebinding attacker's page reaches this loopback socket with its own
  // Host and the browser's Origin; both are refused before dispatch.
  const claudeExports: NormalizedOtlpExport[] = [];
  const logs: string[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    log: (message) => logs.push(message),
    onClaudeExport: (payload) => {
      claudeExports.push(payload);
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  try {
    const body = encodeMetricsPayload({ "service.name": "claude_code" });
    const rebound = await request(
      state.port,
      "POST",
      "/v1/metrics",
      body,
      PROTOBUF_CONTENT_TYPE,
      { Host: "attacker.example", Origin: "http://attacker.example" }
    );
    assert.equal(rebound.status, 403);

    // Each header alone is disqualifying — a page that suppresses one still
    // cannot suppress the other.
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/metrics",
          body,
          PROTOBUF_CONTENT_TYPE,
          {
            Host: "attacker.example",
          }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/metrics",
          body,
          PROTOBUF_CONTENT_TYPE,
          {
            Origin: "http://attacker.example",
          }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await request(
          state.port,
          "POST",
          "/v1/metrics",
          body,
          PROTOBUF_CONTENT_TYPE,
          {
            "Sec-Fetch-Site": "cross-site",
          }
        )
      ).status,
      403
    );

    // The whole point: nothing was persisted, not merely "a 403 was returned".
    assert.deepEqual(claudeExports, []);
    assert.ok(
      logs.some((message) => message.includes("attacker.example")),
      "the refusal names the offending Host so an operator can see it"
    );

    // Positive control: the same body from a real exporter still writes, so the
    // assertions above cannot be passing because the receiver rejects
    // everything.
    const allowed = await postOtlp(state.port, "/v1/metrics", body);
    assert.equal(allowed.status, 200);
    assert.equal(claudeExports.length, 1);
  } finally {
    await receiver.stop();
  }
});

test("ISS-7352: stop() waits for the exports it already acknowledged", async () => {
  // The receiver ACKs before the callback runs, so a callback still in flight
  // at shutdown is data we told the exporter we kept. Dropping it would make
  // the 200 a lie. The contract is that stop() does not RESOLVE until the
  // callback has — asserting only "it eventually landed" would stay green with
  // no drain at all, since the callback still runs, just after everyone left.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let persisted = 0;
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onClaudeExport: async () => {
      await held;
      persisted += 1;
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  const response = await postOtlp(
    state.port,
    "/v1/metrics",
    encodeMetricsPayload({ "service.name": "claude_code" })
  );
  assert.equal(response.status, 200);

  let stopResolved = false;
  const stopped = receiver.stop().then(() => {
    stopResolved = true;
  });
  await drainEventLoop();

  assert.equal(persisted, 0, "the held callback has not run");
  assert.equal(
    stopResolved,
    false,
    "stop() must still be waiting on the acknowledged export"
  );

  release?.();
  await stopped;
  assert.equal(persisted, 1);
});

test("ISS-7352: acknowledged exports run one at a time", async () => {
  // A burst must not fan out onto the shared DB write queue at once.
  //
  // Every callback BLOCKS on one shared gate, which is what makes the
  // assertion sharp: with serialization exactly one can have started while the
  // gate is shut, and without it all eight start immediately. A callback that
  // merely yielded would finish before the next request even arrived, and the
  // test would pass with no serialization at all.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let concurrent = 0;
  let peakConcurrent = 0;
  let settled = 0;
  const receiver = new OtlpHttpReceiver({
    port: 0,
    onClaudeExport: async () => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await gate;
      concurrent -= 1;
      settled += 1;
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  const body = encodeMetricsPayload({ "service.name": "claude_code" });
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => postOtlp(state.port, "/v1/metrics", body))
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    Array.from({ length: 8 }, () => 200)
  );
  await drainEventLoop();

  try {
    assert.equal(
      peakConcurrent,
      1,
      "only one acknowledged export may be in a callback at a time"
    );
  } finally {
    // Released in `finally` so a failed assertion tears the receiver down
    // instead of leaving eight callbacks parked on the gate forever.
    release?.();
    await receiver.stop();
  }
  assert.equal(settled, 8, "every acknowledged export was still drained");
});

test("ISS-7352: the acknowledged-export queue is bounded", async () => {
  // Unbounded, a burst against a slow store grows without limit. At the cap the
  // OLDEST pending export is dropped and SAID SO — a silent drop after a 200 is
  // the failure this bound exists to make visible.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logs: string[] = [];
  let persisted = 0;
  const receiver = new OtlpHttpReceiver({
    port: 0,
    maxPendingDispatches: 2,
    log: (message) => logs.push(message),
    onClaudeExport: async () => {
      await held;
      persisted += 1;
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  const body = encodeMetricsPayload({ "service.name": "claude_code" });
  await Promise.all(
    Array.from({ length: 6 }, () => postOtlp(state.port, "/v1/metrics", body))
  );
  await drainEventLoop();

  release?.();
  await receiver.stop();

  assert.ok(
    logs.some((message) => message.includes("awaiting persistence")),
    "the drop is reported, not silent"
  );
  // One in flight plus the two the queue may hold; the rest were shed.
  assert.ok(
    persisted <= 3,
    `queue stayed bounded, persisted ${persisted} of 6`
  );
});

test("ISS-10717: every evicted export is COUNTED, not only logged", async () => {
  // The log line above says a drop happened; it cannot be read by anything
  // downstream. Until ISS-10717 that was the whole record, so a cloud consumer
  // had no way to tell a session that produced no permission events from one
  // whose export was shed here — every synced count read as authoritative when
  // it was a lower bound.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const droppedHarnesses: string[] = [];
  const receiver = new OtlpHttpReceiver({
    port: 0,
    maxPendingDispatches: 2,
    log: () => {
      // Diagnostics are not the contract under test.
    },
    onClaudeExport: async () => {
      await held;
    },
    onExportDropped: (harness) => {
      droppedHarnesses.push(harness);
    },
  });
  const state = await receiver.start();
  assert.equal(state.available, true);

  const body = encodeMetricsPayload({ "service.name": "claude_code" });
  await Promise.all(
    Array.from({ length: 6 }, () => postOtlp(state.port, "/v1/metrics", body))
  );
  await drainEventLoop();

  release?.();
  await receiver.stop();

  // Six arrived, one in flight plus two queued, so three were shed and each one
  // must have produced its own count: a single call would understate the loss.
  assert.equal(droppedHarnesses.length, 3);
  for (const harness of droppedHarnesses) {
    assert.equal(harness, "claude");
  }
});

/** Lets every already-schedulable continuation and I/O callback settle. */
async function drainEventLoop(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function encodeMetricsPayload(attributes: Record<string, string>): Buffer {
  return encodePayload(OtlpExportKind.Metrics, {
    resourceMetrics: [
      {
        resource: { attributes: encodeAttributes(attributes) },
        scopeMetrics: [
          {
            metrics: [{ name: "claude_code.cost.usage", sum: {} }],
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
  contentType?: string,
  extraHeaders?: Record<string, string>
): Promise<ResponsePayload> {
  return new Promise((resolve, reject) => {
    const baseHeaders =
      body && contentType
        ? {
            "Content-Length": String(body.length),
            "Content-Type": contentType,
          }
        : {};
    const headers = { ...baseHeaders, ...extraHeaders };
    const req = http.request(
      {
        hostname: DEFAULT_OTLP_RECEIVER_HOST,
        port,
        path,
        method,
        headers,
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
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
