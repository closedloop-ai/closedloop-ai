import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import {
  deleteDocumentState,
  loadDocumentState,
  saveDocumentState,
} from "../storage/document-state";

const NAME = "doc:org_1:01a1";
const INSERT_PREFIX = "INSERT INTO document_state";
const LOCK_SQL = "SELECT state FROM document_state WHERE name = $1 FOR UPDATE";
const UPDATE_PREFIX = "UPDATE document_state";
const DELETED_TEXT = "secret";

type Call = { text: string; values?: unknown[] };
type Reply = { rows?: unknown[]; rowCount?: number | null } | Error;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A pool whose client and pool queries answer from `reply`, recording every statement. */
function stubbedPool(reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  const answer = (text: unknown, values?: unknown) => {
    const call: Call = {
      text: String(text),
      values: Array.isArray(values) ? values : undefined,
    };
    calls.push(call);
    const result = reply(call);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve({ rows: [], rowCount: 0, ...result });
  };
  const release = vi.fn();
  const client = Object.assign(new pg.Client(), { release });
  vi.spyOn(client, "query").mockImplementation(answer);
  const pool = new pg.Pool();
  vi.spyOn(pool, "connect").mockImplementation(() => Promise.resolve(client));
  vi.spyOn(pool, "query").mockImplementation(answer);
  return { pool, calls, release };
}

function textState(text: string): Uint8Array {
  const doc = new Doc();
  doc.getText("t").insert(0, text);
  const state = encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function readText(state: Uint8Array): string {
  const doc = new Doc();
  applyUpdate(doc, state);
  const text = doc.getText("t").toString();
  doc.destroy();
  return text;
}

function statements(calls: Call[]): string[] {
  return calls.map(({ text }) => {
    if (text.startsWith(INSERT_PREFIX)) {
      return "INSERT";
    }
    if (text === LOCK_SQL) {
      return "LOCK";
    }
    if (text.startsWith(UPDATE_PREFIX)) {
      return "UPDATE";
    }
    return text;
  });
}

describe("loadDocumentState", () => {
  it("returns the stored state as a Uint8Array", async () => {
    const { pool, calls } = stubbedPool(() => ({
      rows: [{ state: Buffer.from([1, 2, 3]) }],
    }));

    const state = await loadDocumentState(pool, NAME);

    expect(state).toBeInstanceOf(Uint8Array);
    expect(Array.from(state ?? [])).toEqual([1, 2, 3]);
    expect(calls).toEqual([
      {
        text: "SELECT state FROM document_state WHERE name = $1",
        values: [NAME],
      },
    ]);
  });

  it("returns null for a document never stored", async () => {
    const { pool } = stubbedPool(() => ({ rows: [] }));

    await expect(loadDocumentState(pool, NAME)).resolves.toBeNull();
  });
});

describe("deleteDocumentState", () => {
  it("is true when a row existed", async () => {
    const { pool, calls } = stubbedPool(() => ({ rowCount: 1 }));

    await expect(deleteDocumentState(pool, NAME)).resolves.toBe(true);
    expect(calls).toEqual([
      {
        text: "DELETE FROM document_state WHERE name = $1 RETURNING name",
        values: [NAME],
      },
    ]);
  });

  it("is false when no row existed", async () => {
    const { pool } = stubbedPool(() => ({ rowCount: 0 }));

    await expect(deleteDocumentState(pool, NAME)).resolves.toBe(false);
  });

  it("is false when the driver reports a null rowCount", async () => {
    const { pool } = stubbedPool(() => ({ rowCount: null }));

    await expect(deleteDocumentState(pool, NAME)).resolves.toBe(false);
  });
});

describe("saveDocumentState", () => {
  it("inserts a first save and commits without locking", async () => {
    const update = textState("hello");
    const { pool, calls, release } = stubbedPool(({ text }) =>
      text.startsWith(INSERT_PREFIX) ? { rowCount: 1 } : {}
    );

    await saveDocumentState(pool, NAME, update);

    expect(statements(calls)).toEqual(["BEGIN", "INSERT", "COMMIT"]);
    expect(calls[1]?.values).toEqual([NAME, Buffer.from(update)]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("merges into the locked row when the insert conflicts, keeping both writers' text", async () => {
    const stored = textState("stored");
    const update = textState("update");
    const { pool, calls } = stubbedPool(({ text }) => {
      if (text === LOCK_SQL) {
        return { rows: [{ state: Buffer.from(stored) }] };
      }
      return {};
    });

    await saveDocumentState(pool, NAME, update);

    expect(statements(calls)).toEqual([
      "BEGIN",
      "INSERT",
      "LOCK",
      "UPDATE",
      "COMMIT",
    ]);
    expect(calls[2]?.values).toEqual([NAME]);
    const write = calls[3]?.values;
    expect(write?.[0]).toBe(NAME);
    const mergedText = readText(new Uint8Array(write?.[1] as Buffer));
    expect(mergedText).toContain("stored");
    expect(mergedText).toContain("update");
  });

  it("writes no bytes of stored text the update deleted", async () => {
    const doc = new Doc();
    doc.getText("t").insert(0, DELETED_TEXT);
    const stored = Buffer.from(encodeStateAsUpdate(doc));
    doc.getText("t").delete(0, DELETED_TEXT.length);
    const update = encodeStateAsUpdate(doc);
    doc.destroy();
    const { pool, calls } = stubbedPool(({ text }) =>
      text === LOCK_SQL ? { rows: [{ state: stored }] } : {}
    );

    await saveDocumentState(pool, NAME, update);

    expect(stored.includes(Buffer.from(DELETED_TEXT))).toBe(true);
    expect(statements(calls)[3]).toBe("UPDATE");
    const written = calls[3]?.values?.[1];
    if (!Buffer.isBuffer(written)) {
      throw new Error("the UPDATE carried no state buffer");
    }
    expect(written.includes(Buffer.from(DELETED_TEXT))).toBe(false);
    expect(readText(new Uint8Array(written))).toBe("");
  });

  it("retries the insert when the row was deleted between the conflict and the lock", async () => {
    let inserts = 0;
    const { pool, calls } = stubbedPool(({ text }) => {
      if (text.startsWith(INSERT_PREFIX)) {
        inserts += 1;
        return { rowCount: inserts === 2 ? 1 : 0 };
      }
      return { rows: [] };
    });

    await saveDocumentState(pool, NAME, textState("x"));

    expect(statements(calls)).toEqual([
      "BEGIN",
      "INSERT",
      "LOCK",
      "INSERT",
      "COMMIT",
    ]);
  });

  it("gives up after three deleted-row attempts, rolls back, and releases", async () => {
    const { pool, calls, release } = stubbedPool(() => ({ rows: [] }));

    await expect(saveDocumentState(pool, NAME, textState("x"))).rejects.toThrow(
      `document_state row ${NAME} was deleted under 3 consecutive saves`
    );

    expect(statements(calls)).toEqual([
      "BEGIN",
      "INSERT",
      "LOCK",
      "INSERT",
      "LOCK",
      "INSERT",
      "LOCK",
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rethrows the statement's error when the rollback also fails", async () => {
    const failure = new Error("insert failed");
    const { pool, calls, release } = stubbedPool(({ text }) => {
      if (text.startsWith(INSERT_PREFIX)) {
        return failure;
      }
      if (text === "ROLLBACK") {
        return new Error("rollback failed");
      }
      return {};
    });

    await expect(saveDocumentState(pool, NAME, textState("x"))).rejects.toBe(
      failure
    );
    expect(statements(calls)).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
