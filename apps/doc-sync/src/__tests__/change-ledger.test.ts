import {
  DOC_SYNC_CALLBACK_MAX_ID_LENGTH,
  DocSyncChangeSource,
} from "@repo/realtime-contract/doc-sync-internal";
import { describe, expect, it } from "vitest";
import { createChangeLedger } from "../callbacks/change-ledger";

const DOCUMENT = "org:artifact:PLN-1";
const OTHER_DOCUMENT = "org:artifact:PLN-2";

/** What Hocuspocus 4.7.0 passes `onChange` for a client's update. */
function connectionChange(documentName: string, userId: string) {
  const context = { userId, orgId: "org", tokenIssuedAt: 1 };
  return {
    documentName,
    transactionOrigin: { source: "connection", connection: { context } },
    context,
  };
}

/** What Hocuspocus 4.7.0 passes `onChange` for a direct connection's transaction. */
function localChange(documentName: string, context: unknown) {
  return {
    documentName,
    transactionOrigin: { source: "local", context },
    context,
  };
}

describe("createChangeLedger", () => {
  it("records each connection's user id and the connection source, with the change window", () => {
    let clock = 1000;
    const ledger = createChangeLedger({ now: () => clock });

    ledger.record(connectionChange(DOCUMENT, "user-a"));
    clock = 3000;
    ledger.record(connectionChange(DOCUMENT, "user-b"));
    ledger.record(connectionChange(DOCUMENT, "user-a"));

    expect(ledger.take(DOCUMENT)).toEqual({
      sources: new Set([DocSyncChangeSource.Connection]),
      editorUserIds: new Set(["user-a", "user-b"]),
      firstChangedAt: 1000,
      lastChangedAt: 3000,
    });
  });

  it("records a seed-version direct connection's source and no editor", () => {
    const ledger = createChangeLedger();

    ledger.record(
      localChange(DOCUMENT, {
        source: DocSyncChangeSource.SeedVersion,
        version: 3,
      })
    );

    expect(ledger.take(DOCUMENT)).toMatchObject({
      sources: new Set([DocSyncChangeSource.SeedVersion]),
      editorUserIds: new Set(),
    });
  });

  it("records nothing for a local origin without a change source, or another origin", () => {
    const ledger = createChangeLedger();

    ledger.record(localChange(DOCUMENT, {}));
    ledger.record({
      documentName: DOCUMENT,
      transactionOrigin: { source: "redis" },
      context: {},
    });
    ledger.record({
      documentName: DOCUMENT,
      transactionOrigin: null,
      context: {},
    });

    expect(ledger.take(DOCUMENT)).toBeUndefined();
  });

  it("records the change but not an editor id the callback cannot carry", () => {
    const ledger = createChangeLedger();

    ledger.record(
      connectionChange(
        DOCUMENT,
        "u".repeat(DOC_SYNC_CALLBACK_MAX_ID_LENGTH + 1)
      )
    );
    ledger.record(connectionChange(DOCUMENT, "user-a"));

    expect(ledger.take(DOCUMENT)).toMatchObject({
      sources: new Set([DocSyncChangeSource.Connection]),
      editorUserIds: new Set(["user-a"]),
    });
  });

  it("keeps documents apart, empties an entry on take and drops it on forget", () => {
    const ledger = createChangeLedger();
    ledger.record(connectionChange(DOCUMENT, "user-a"));
    ledger.record(connectionChange(OTHER_DOCUMENT, "user-b"));

    expect(ledger.take(DOCUMENT)?.editorUserIds).toEqual(new Set(["user-a"]));
    expect(ledger.take(DOCUMENT)).toBeUndefined();
    ledger.forget(OTHER_DOCUMENT);
    expect(ledger.take(OTHER_DOCUMENT)).toBeUndefined();
  });
});
