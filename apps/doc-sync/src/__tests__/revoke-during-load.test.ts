import { REVOCATION_RETENTION_MS } from "@repo/realtime-contract/revocations";
import { describe, expect, it } from "vitest";
import { ORG } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";
import { appendParagraph } from "./support/documents";
import {
  closed,
  revokeServerPerTest,
  SLUG_X,
  TEST_TIMEOUT_MS,
  tokenFor,
  USER_A,
  USER_B,
  WAIT_MS,
  X,
} from "./support/revoke-server";

const server = revokeServerPerTest();

describe("POST /internal/revoke while a document loads", () => {
  it(
    "closes a connection that authenticated before the revoke while its document was still loading",
    async () => {
      const release = server.holdLoads();
      const client = await server.connected(
        X,
        await tokenFor(USER_A, ORG, SLUG_X)
      );
      expect(server.isLoading(X)).toBe(true);

      expect(await server.revoke({ userId: USER_A })).toEqual({
        closedConnections: 0,
      });
      release();

      await closed([client]);
      expect(server.usersOn(X)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "applies none of the edits a revoked client sent while its document was loading",
    async () => {
      const release = server.holdLoads();
      const a = await server.connected(X, await tokenFor(USER_A, ORG, SLUG_X));
      const b = await server.connected(X, await tokenFor(USER_B, ORG, SLUG_X));
      appendParagraph(a.doc, "queued by A during the load");

      await server.revoke({ userId: USER_A });
      release();
      await closed([a]);
      appendParagraph(b.doc, "edited by B");

      await waitFor(
        () => server.serverText(X).includes("edited by B"),
        "B's edit on the server",
        WAIT_MS
      );
      expect(server.serverText(X)).not.toContain("queued by A during the load");
      expect(server.usersOn(X)).toEqual([USER_B]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps an attached connection writing after its token outlives the revoke ledger",
    async () => {
      const client = await server.connected(
        X,
        await tokenFor(USER_A, ORG, SLUG_X)
      );
      await waitFor(
        () => server.usersOn(X).length === 1,
        "A attached",
        WAIT_MS
      );
      server.setClock(() => Date.now() + REVOCATION_RETENTION_MS);

      appendParagraph(client.doc, "edited with an old token");

      await waitFor(
        () => server.serverText(X).includes("edited with an old token"),
        "A's edit on the server",
        WAIT_MS
      );
      expect(client.closes).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "closes a loading connection once the revoke ledger may have dropped its revoke",
    async () => {
      const release = server.holdLoads();
      const client = await server.connected(
        X,
        await tokenFor(USER_A, ORG, SLUG_X)
      );
      await server.revoke({ userId: USER_A });
      const revokedAt = Date.now();
      server.setClock(() => revokedAt + REVOCATION_RETENTION_MS);

      release();

      await closed([client]);
      expect(server.usersOn(X)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});
