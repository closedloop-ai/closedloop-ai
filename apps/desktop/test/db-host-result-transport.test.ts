/**
 * @file db-host-result-transport.test.ts
 * @description ISS-12022 — a db-host result is serialized once on the store
 * thread, transferred to the dispatcher, forwarded to main as bytes (paged past
 * one page, only as main pulls), and decoded once in main.
 *
 * The production modules run end to end here: `postEncodedStoreResult` posts
 * through a real `MessageChannel`, `createDbStoreClient` settles the inner
 * reply, `createDbHostResultDelivery` serves main, and `settleDbHostResult` is
 * main's handler. Only the two process boundaries are stand-ins.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  isDbHostRequest,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  type DbHostPending,
  settleDbHostResult,
} from "../src/main/database/db-host/db-host-result-assembly.js";
import {
  DB_HOST_RESULT_PAGE_BYTES,
  EncodedDbHostResult,
  encodeDbHostResult,
} from "../src/main/database/db-host/db-host-result-codec.js";
import { createDbHostResultDelivery } from "../src/main/database/db-host/db-host-result-delivery.js";
import { createDbStoreClient } from "../src/main/database/db-host/db-store-client.js";
import {
  DbStoreResponseKind,
  isDbStoreResponse,
} from "../src/main/database/db-host/db-store-protocol.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { callSitesOf, parseModuleSource } from "./support/app-module-ast.js";
import {
  fakeWorker,
  largeResult,
  mainSide,
  noopRelay,
  postFromStore,
  settleOnDispatcher,
} from "./support/db-host-result-transport-fixtures.js";

const DB_HOST_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host"
);

describe("ISS-12022: a db-host result crosses the dispatcher as bytes", () => {
  it("delivers a multi-page result to main equal to the structured clone it replaced", async () => {
    const value = largeResult();
    const encodedBytes = encodeDbHostResult(value).byteLength;
    assert.ok(
      encodedBytes > 3 * DB_HOST_RESULT_PAGE_BYTES,
      `fixture must span several pages, encoded to ${encodedBytes} bytes`
    );

    const { received, storeBytesAfterPost } = await postFromStore(value);
    assert.equal(
      storeBytesAfterPost,
      0,
      "the store thread TRANSFERS its encoding instead of keeping a copy"
    );
    assert.ok(isDbStoreResponse(received), "the dispatcher accepts the reply");
    const forwarded = await settleOnDispatcher(received);
    assert.ok(
      forwarded instanceof EncodedDbHostResult,
      "the dispatcher forwards the store's bytes, not a decoded copy"
    );

    const main = mainSide();
    const settled = main.await(1);
    const delivery = createDbHostResultDelivery({
      post: main.receive,
      log: () => {},
    });
    const delivered = delivery.deliver(1, forwarded);
    main.servePulls(delivery);
    assert.deepEqual(await settled, structuredClone(value));
    await delivered;
    const pageSizes = main.received.map((message) =>
      "encoded" in message && message.encoded instanceof ArrayBuffer
        ? message.encoded.byteLength
        : 0
    );
    assert.ok(
      pageSizes.length >= 4 &&
        pageSizes.every((size) => size <= DB_HOST_RESULT_PAGE_BYTES),
      `every post to main is one page at most: ${JSON.stringify(pageSizes)}`
    );
    assert.equal(
      pageSizes.reduce((sum, size) => sum + size, 0),
      encodedBytes
    );
  });

  it("holds delivery open until main has pulled the last page", async () => {
    const value = largeResult();
    const posts: DbHostResponse[] = [];
    const delivery = createDbHostResultDelivery({
      post: (message) => posts.push(message),
      log: () => {},
    });
    let finished = false;
    const delivered = delivery
      .deliver(5, new EncodedDbHostResult(encodeDbHostResult(value)))
      .then(() => {
        finished = true;
      });
    await Promise.resolve();
    assert.equal(posts.length, 1, "only the first page goes unasked");
    assert.equal(finished, false, "the lane permit is still held");

    const total = encodeDbHostResult(value).byteLength;
    for (
      let offset = DB_HOST_RESULT_PAGE_BYTES;
      offset < total;
      offset += DB_HOST_RESULT_PAGE_BYTES
    ) {
      assert.equal(finished, false, `released before the page at ${offset}`);
      delivery.pull(5, offset);
      await Promise.resolve();
    }
    await delivered;
    assert.equal(posts.at(-1)?.kind, DbHostResponseKind.ResultPage);
  });

  it("can deliver one encoded result to several callers", async () => {
    // The insights cache single-flights one computed value to every requester,
    // so delivering it must not consume the bytes.
    for (const value of [largeResult(), { total: 3 }]) {
      const result = new EncodedDbHostResult(encodeDbHostResult(value));
      const main = mainSide();
      const delivery = createDbHostResultDelivery({
        post: main.receive,
        log: () => {},
      });
      for (const id of [1, 2]) {
        const settled = main.await(id);
        const delivered = delivery.deliver(id, result);
        main.servePulls(delivery);
        await delivered;
        assert.deepEqual(await settled, structuredClone(value));
      }
    }
  });

  it("still accepts a plain value from a store or dispatcher that did not encode", async () => {
    const worker = fakeWorker();
    const client = createDbStoreClient({
      ...noopRelay(),
      createWorker: () => worker.handle,
    });
    const executed = client.execute("sessions.count", []);
    worker.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: 7,
    });
    const forwarded = await executed;
    assert.equal(forwarded, 7);

    const posts: DbHostResponse[] = [];
    await createDbHostResultDelivery({
      post: (message) => posts.push(message),
      log: () => {},
    }).deliver(9, forwarded);
    assert.deepEqual(posts, [
      { kind: DbHostResponseKind.Result, id: 9, ok: true, value: 7 },
    ]);

    const values: unknown[] = [];
    const pending = new Map<number, DbHostPending>([
      [9, { resolve: (value) => values.push(value), reject: assert.fail }],
    ]);
    settleDbHostResult(
      { kind: DbHostResponseKind.Result, id: 9, ok: true, value: 7 },
      pending,
      () => assert.fail("a plain value is never paged")
    );
    assert.deepEqual(values, [7]);
  });

  it("refuses an inner reply whose encoding is not a buffer", () => {
    assert.equal(
      isDbStoreResponse({
        kind: DbStoreResponseKind.Result,
        id: 1,
        ok: true,
        encoded: "not-bytes",
      }),
      false
    );
  });
});

describe("ISS-12022: main's DbHostClient assembles a paged result", () => {
  it("pulls every page through the real guards and resolves the invoke", async () => {
    // Every message crosses `structuredClone`, as the utilityProcess boundary
    // would, and each side applies its real guard: `isDbHostRequest` here as the
    // dispatcher's listener does, `isDbHostResponse` inside the client.
    const value = largeResult();
    const result = new EncodedDbHostResult(encodeDbHostResult(value));
    const posted: DbHostRequest[] = [];
    let toMain: DbHostChildMessageListener | undefined;
    const delivery = createDbHostResultDelivery({
      post: (message) => toMain?.(structuredClone(message)),
      log: () => {},
    });
    const answer = (request: DbHostRequest): void => {
      if (request.kind === DbHostRequestKind.Init) {
        toMain?.({ kind: DbHostResponseKind.Ready, id: request.id });
      } else if (request.kind === DbHostRequestKind.Invoke) {
        delivery
          .deliver(request.id, result)
          .catch((error: unknown) => assert.fail(String(error)));
      } else if (request.kind === DbHostRequestKind.ResultPagePull) {
        delivery.pull(request.id, request.offset);
      }
    };
    const child = {
      stderr: null,
      on(...args: DbHostChildListenerArgs): unknown {
        if (args[0] === "message") {
          toMain = args[1];
        }
        return child;
      },
      postMessage(message: DbHostRequest) {
        const request: unknown = structuredClone(message);
        if (!isDbHostRequest(request)) {
          return;
        }
        posted.push(request);
        queueMicrotask(() => answer(request));
      },
      kill: () => {},
    };
    const client = new DbHostClient({
      onEmit: () => {},
      onLog: () => {},
      fork: () => child,
    });
    await client.start({ dataDir: "/tmp/iss-12022-unused" });

    assert.deepEqual(
      await client.invoke("sessions.detail", []),
      structuredClone(value)
    );
    const pulls = posted.filter(
      (request) => request.kind === DbHostRequestKind.ResultPagePull
    );
    assert.equal(
      pulls.length,
      Math.ceil(result.bytes.byteLength / DB_HOST_RESULT_PAGE_BYTES) - 1
    );
    assert.equal(client.pendingRequestCount, 0);
  }, 10_000);
});

describe("ISS-12022: the two un-importable threads are wired to the transport", () => {
  it("the store thread posts every success through the encoder", () => {
    const file = path.join(DB_HOST_DIR, "db-store-worker.ts");
    const source = parseModuleSource(readFileSync(file, "utf8"), file);
    assert.equal(callSitesOf("postEncodedStoreResult", source).length, 1);
    // The transfer list reaches the port, or the "transfer" is a full copy.
    const posts = callSitesOf("postMessage", source);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].arguments.length, 2);
  });

  it("the dispatcher delivers through the paged delivery and serves pulls", () => {
    const file = path.join(DB_HOST_DIR, "db-host-worker.ts");
    const source = parseModuleSource(readFileSync(file, "utf8"), file);
    assert.equal(callSitesOf("createDbHostResultDelivery", source).length, 1);
    assert.equal(callSitesOf("deliver", source).length, 1);
    assert.equal(callSitesOf("pull", source).length, 1);
  });
});
