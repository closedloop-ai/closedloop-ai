import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { Database } from "@hocuspocus/extension-database";
import type { Extension, HookName } from "@hocuspocus/server";
import { log } from "@repo/observability/log";
import { Origin } from "@repo/observability/telemetry/origin";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Doc } from "yjs";
import { DocSyncAuthError } from "../auth/authorize";
import {
  DOC_SYNC_HOOK_FAILED_EVENT,
  guardExtension,
  HookFailurePolicy,
  INTERNAL_ERROR_UPGRADE_RESPONSE,
} from "../hooks/hook-guard";
import { DocSyncCount } from "../telemetry/metrics";
import { metricSamples } from "./support/metric-samples";

const SENTINEL = "sentinel-message-carrying-document-content";
const DOCUMENT = "doc-a";

let info: ReturnType<typeof spyInfo>;
let error: ReturnType<typeof spyError>;

function spyInfo() {
  return vi.spyOn(log, "info").mockImplementation(() => undefined);
}

function spyError() {
  return vi.spyOn(log, "error").mockImplementation(() => undefined);
}

beforeEach(() => {
  info = spyInfo();
  error = spyError();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Calls a guarded hook with a payload of the test's own shape. */
function callHook(
  extension: Extension,
  name: HookName,
  payload: unknown
): Promise<unknown> {
  const hook = extension[name];
  if (typeof hook !== "function") {
    throw new Error(`${name} is not guarded`);
  }
  return Reflect.apply(hook, extension, [payload]);
}

function throwing(name: HookName, failure: unknown): Extension {
  return guardExtension({ [name]: () => Promise.reject(failure) }, "test");
}

function hookFailures() {
  return error.mock.calls.filter(
    ([, fields]) =>
      typeof fields === "object" &&
      fields !== null &&
      "event" in fields &&
      fields.event === DOC_SYNC_HOOK_FAILED_EVENT
  );
}

describe("guardExtension", () => {
  it("contains a throwing Contain hook: logs ids and codes, counts it, resolves", async () => {
    const failure = new Error(SENTINEL);

    await expect(
      callHook(throwing("onChange", failure), "onChange", {
        documentName: DOCUMENT,
      })
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith("Doc sync hook failed", {
      event: DOC_SYNC_HOOK_FAILED_EVENT,
      hook: "onChange",
      extension: "test",
      documentName: DOCUMENT,
      code: "Error",
      policy: HookFailurePolicy.Contain,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(SENTINEL);
    expect(metricSamples(info)).toEqual([
      {
        metric: DocSyncCount.HookErrors,
        count: 1,
        hook: "onChange",
        origin: Origin.DocSync,
        _telemetryMetric: true,
      },
    ]);
  });

  it("rethrows a throwing Propagate hook's error unchanged, after logging it", async () => {
    const failure = Object.assign(new Error(SENTINEL), { code: "57P01" });

    await expect(
      callHook(throwing("onLoadDocument", failure), "onLoadDocument", {
        documentName: DOCUMENT,
      })
    ).rejects.toBe(failure);

    expect(hookFailures()).toEqual([
      [
        "Doc sync hook failed",
        {
          event: DOC_SYNC_HOOK_FAILED_EVENT,
          hook: "onLoadDocument",
          extension: "test",
          documentName: DOCUMENT,
          code: "57P01",
          policy: HookFailurePolicy.Propagate,
        },
      ],
    ]);
    expect(metricSamples(info)).toHaveLength(1);
  });

  it("omits documentName when the payload carries none", async () => {
    await callHook(throwing("onDestroy", new Error(SENTINEL)), "onDestroy", {});

    expect(hookFailures()[0]?.[1]).not.toHaveProperty("documentName");
  });

  it("passes a refusal carrying a string reason through a Propagate hook unlogged", async () => {
    const refusal = new DocSyncAuthError(RealtimeErrorCode.Unauthorized);

    await expect(
      callHook(throwing("onAuthenticate", refusal), "onAuthenticate", {
        documentName: DOCUMENT,
      })
    ).rejects.toBe(refusal);

    expect(error).not.toHaveBeenCalled();
    expect(metricSamples(info)).toEqual([]);
  });

  it("logs an error carrying a reason on a Contain hook: only Propagate hooks refuse", async () => {
    const refusal = new DocSyncAuthError(RealtimeErrorCode.Unauthorized);

    await expect(
      callHook(throwing("connected", refusal), "connected", {})
    ).resolves.toBeUndefined();

    expect(hookFailures()).toHaveLength(1);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("passes a rejection with %s through unlogged", async (_label, value) => {
    await expect(
      callHook(throwing("onUpgrade", value), "onUpgrade", {})
    ).rejects.toBe(value);

    expect(error).not.toHaveBeenCalled();
    expect(metricSamples(info)).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])(
    "contains a Contain hook's rejection with %s: logs, counts, resolves",
    async (_label, value) => {
      await expect(
        callHook(throwing("onDisconnect", value), "onDisconnect", {
          documentName: DOCUMENT,
        })
      ).resolves.toBeUndefined();

      expect(hookFailures()[0]?.[1]).toMatchObject({
        hook: "onDisconnect",
        code: "unknown",
        policy: HookFailurePolicy.Contain,
      });
      expect(metricSamples(info)).toHaveLength(1);
    }
  );

  it("answers a throwing onRequest 500 and rejects with no value", async () => {
    const response = new ServerResponse(new IncomingMessage(new Socket()));

    await expect(
      callHook(throwing("onRequest", new Error(SENTINEL)), "onRequest", {
        response,
      })
    ).rejects.toBeUndefined();

    expect(response.statusCode).toBe(500);
    expect(response.writableEnded).toBe(true);
    expect(hookFailures()[0]?.[1]).toMatchObject({
      hook: "onRequest",
      policy: HookFailurePolicy.Answer,
    });
  });

  it("destroys an onRequest response whose headers were already sent", async () => {
    const response = new ServerResponse(new IncomingMessage(new Socket()));
    response.writeHead(200);
    response.write("partial");
    const destroy = vi.spyOn(response, "destroy");

    await expect(
      callHook(throwing("onRequest", new Error(SENTINEL)), "onRequest", {
        response,
      })
    ).rejects.toBeUndefined();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });

  it("answers a throwing onUpgrade with a 500 line on the socket and rejects with no value", async () => {
    const socket = new PassThrough();
    const end = vi.spyOn(socket, "end");

    await expect(
      callHook(throwing("onUpgrade", new Error(SENTINEL)), "onUpgrade", {
        socket,
      })
    ).rejects.toBeUndefined();

    expect(end).toHaveBeenCalledWith(INTERNAL_ERROR_UPGRADE_RESPONSE);
  });

  it("guards the Database extension's prototype hooks and keeps their this", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error(SENTINEL)));
    const guarded = guardExtension(new Database({ fetch }), "database");
    const payload = { documentName: DOCUMENT, document: new Doc() };

    await expect(callHook(guarded, "onLoadDocument", payload)).rejects.toThrow(
      SENTINEL
    );

    expect(fetch).toHaveBeenCalledWith(payload);
    expect(hookFailures()[0]?.[1]).toMatchObject({
      hook: "onLoadDocument",
      extension: "database",
      code: "Error",
    });
    expect(guarded).toHaveProperty("onStoreDocument");
  });

  it("adds no hook the extension lacks, and keeps its priority", () => {
    const guarded = guardExtension(
      { priority: 200, onChange: () => Promise.resolve() },
      "test"
    );

    expect(Object.keys(guarded).sort()).toEqual(["onChange", "priority"]);
    expect(guarded.priority).toBe(200);
  });

  it("resolves a hook's own value unchanged", async () => {
    const context = { userId: "user-1", orgId: "org-1" };
    const guarded = guardExtension(
      { onAuthenticate: () => Promise.resolve(context) },
      "test"
    );

    await expect(callHook(guarded, "onAuthenticate", {})).resolves.toBe(
      context
    );
  });
});
