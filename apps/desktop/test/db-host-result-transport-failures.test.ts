/**
 * @file db-host-result-transport-failures.test.ts
 * @description ISS-12022 — a failed, cancelled, malformed or abandoned db-host
 * result still fails its read, never resolves garbage, and never holds the
 * dispatcher's lane permit past the point main gives up on it.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import {
  type DbHostResponse,
  DbHostResponseKind,
  serializeDbHostError,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  type DbHostPending,
  settleDbHostResult,
} from "../src/main/database/db-host/db-host-result-assembly.js";
import {
  DB_HOST_RESULT_ABANDON_OFFSET,
  DB_HOST_RESULT_PAGE_BYTES,
  EncodedDbHostResult,
  encodeDbHostResult,
  postEncodedStoreResult,
} from "../src/main/database/db-host/db-host-result-codec.js";
import { createDbHostResultDelivery } from "../src/main/database/db-host/db-host-result-delivery.js";
import {
  createDbStoreClient,
  serializedDbStoreError,
} from "../src/main/database/db-host/db-store-client.js";
import { STORE_INVOKE_DEADLINE_MS } from "../src/main/database/db-host/db-store-deadlines.js";
import { DbStoreResponseKind } from "../src/main/database/db-host/db-store-protocol.js";
import {
  DesktopReadCancelledError,
  isReadCancelledError,
} from "../src/shared/read-cancellation-contract.js";
import {
  fakeWorker,
  largeResult,
  noopRelay,
} from "./support/db-host-result-transport-fixtures.js";

const COULD_NOT_BE_CLONED = /could not be cloned/;
const ARRIVED_MALFORMED = /arrived malformed/;

describe("ISS-12022: a failed or cancelled read still fails, and never resolves garbage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws before posting when the store's value cannot be serialized", () => {
    const post = vi.fn();
    assert.throws(
      () => postEncodedStoreResult(post, 1, { callback: () => 1 }),
      COULD_NOT_BE_CLONED
    );
    assert.equal(post.mock.calls.length, 0);
  });

  it("carries a cancelled store read to main as a cancellation", async () => {
    const worker = fakeWorker();
    const client = createDbStoreClient({
      ...noopRelay(),
      createWorker: () => worker.handle,
    });
    const executed = client.execute("syncSource.aggregateAnalytics", [], "tok");
    worker.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: false,
      error: serializeDbHostError(new DesktopReadCancelledError()),
    });
    const relayed = await executed.then(
      () => assert.fail("a cancelled read must not resolve"),
      (error: unknown) => error
    );

    const pending = new Map<number, DbHostPending>();
    const settled = new Promise<unknown>((resolve, reject) => {
      pending.set(4, { resolve, reject });
    });
    settleDbHostResult(
      {
        kind: DbHostResponseKind.Result,
        id: 4,
        ok: false,
        error: serializedDbStoreError(relayed) ?? { message: "lost" },
      },
      pending,
      () => assert.fail("a failure is never paged")
    );
    const error = await settled.then(
      () => assert.fail("must reject"),
      (rejection: unknown) => rejection
    );
    assert.ok(isReadCancelledError(error), String(error));
    assert.equal(pending.size, 0);
  });

  it("rejects corrupt bytes and an out-of-order page instead of resolving", async () => {
    const corrupt = new Map<number, DbHostPending>();
    const corruptRead = new Promise<unknown>((resolve, reject) => {
      corrupt.set(1, { resolve, reject });
    });
    settleDbHostResult(
      {
        kind: DbHostResponseKind.Result,
        id: 1,
        ok: true,
        encoded: new Uint8Array([0xff, 0x0f, 0x6f, 0x22]).buffer,
      },
      corrupt,
      () => assert.fail("not paged")
    );
    await assert.rejects(corruptRead);

    // A length no buffer can hold rejects the read; it must not throw out of
    // main's message handler.
    const huge = new Map<number, DbHostPending>();
    const hugeRead = new Promise<unknown>((resolve, reject) => {
      huge.set(3, { resolve, reject });
    });
    const hugePulls: number[] = [];
    settleDbHostResult(
      {
        kind: DbHostResponseKind.Result,
        id: 3,
        ok: true,
        encoded: new ArrayBuffer(8),
        encodedByteLength: Number.MAX_SAFE_INTEGER,
      },
      huge,
      (_id, offset) => hugePulls.push(offset)
    );
    await assert.rejects(hugeRead, ARRIVED_MALFORMED);
    assert.deepEqual(
      hugePulls,
      [DB_HOST_RESULT_ABANDON_OFFSET],
      "the child's delivery is abandoned too"
    );

    const bytes = encodeDbHostResult(largeResult());
    const paged = new Map<number, DbHostPending>();
    const pagedRead = new Promise<unknown>((resolve, reject) => {
      paged.set(2, { resolve, reject });
    });
    const pulls: number[] = [];
    settleDbHostResult(
      {
        kind: DbHostResponseKind.Result,
        id: 2,
        ok: true,
        encoded: bytes.slice(0, DB_HOST_RESULT_PAGE_BYTES),
        encodedByteLength: bytes.byteLength,
      },
      paged,
      (_id, offset) => pulls.push(offset)
    );
    assert.deepEqual(pulls, [DB_HOST_RESULT_PAGE_BYTES]);
    settleDbHostResult(
      {
        kind: DbHostResponseKind.ResultPage,
        id: 2,
        offset: 2 * DB_HOST_RESULT_PAGE_BYTES,
        encoded: bytes.slice(
          2 * DB_HOST_RESULT_PAGE_BYTES,
          3 * DB_HOST_RESULT_PAGE_BYTES
        ),
      },
      paged,
      (_id, offset) => pulls.push(offset)
    );
    // Raced against one loop turn: a page main wrongly accepted would leave the
    // read waiting on a pull nobody answers, not rejected.
    const outcome = await Promise.race([
      pagedRead.then(
        () => "resolved",
        (error: unknown) => String(error)
      ),
      new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    assert.match(outcome, ARRIVED_MALFORMED);
    assert.deepEqual(
      pulls,
      [DB_HOST_RESULT_PAGE_BYTES, DB_HOST_RESULT_ABANDON_OFFSET],
      "main abandons the child's delivery instead of leaving it to expire"
    );
    assert.equal(
      paged.size,
      0,
      "the partial buffer is released with the request"
    );
  });

  it("releases the lane at once when main abandons a paged result", async () => {
    const posts: DbHostResponse[] = [];
    const delivery = createDbHostResultDelivery({
      post: (message) => posts.push(message),
      log: () => {},
    });
    const delivered = delivery.deliver(
      6,
      new EncodedDbHostResult(encodeDbHostResult(largeResult()))
    );
    delivery.pull(6, DB_HOST_RESULT_ABANDON_OFFSET);
    const permit = await Promise.race([
      delivered.then(() => "released"),
      new Promise<string>((resolve) => setImmediate(() => resolve("held"))),
    ]);
    assert.equal(permit, "released");
    assert.equal(posts.length, 2);
    assert.equal((posts[1] as { ok?: boolean }).ok, false);
  });

  it("releases the lane and fails the read when main stops pulling", async () => {
    vi.useFakeTimers();
    const posts: DbHostResponse[] = [];
    const logs: string[] = [];
    const delivery = createDbHostResultDelivery({
      post: (message) => posts.push(message),
      log: (line) => logs.push(line),
    });
    const delivered = delivery.deliver(
      3,
      new EncodedDbHostResult(encodeDbHostResult(largeResult()))
    );
    await vi.advanceTimersByTimeAsync(STORE_INVOKE_DEADLINE_MS);
    await delivered;
    assert.deepEqual(posts.at(-1), {
      kind: DbHostResponseKind.Result,
      id: 3,
      ok: false,
      error: { message: "db-host result 3 expired before main pulled it" },
    });
    assert.equal(logs.length, 1);

    const before = posts.length;
    delivery.pull(3, DB_HOST_RESULT_PAGE_BYTES);
    assert.deepEqual(
      posts.slice(before).map((message) => message.kind),
      [DbHostResponseKind.Result],
      "a late pull is answered with a failure, never a stale page"
    );
    assert.equal((posts.at(-1) as { ok?: boolean }).ok, false);
  });
});
