import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  DocSyncDocumentCommand,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { describe, expect, it, vi } from "vitest";
import {
  DOC_SYNC_DISCONNECT_APPLIED_EVENT,
  DOC_SYNC_REVOKE_APPLIED_EVENT,
} from "../commands/connection-control";
import { ORG } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";
import { appendParagraph } from "./support/documents";
import {
  closed,
  firstOutcome,
  revokeServerPerTest,
  SLUG_X,
  TEST_TIMEOUT_MS,
  text,
  tokenFor,
  tokenIssuedAt,
  USER_A,
  USER_B,
  USER_C,
  USER_D,
  WAIT_MS,
  X,
  Y,
  Z,
} from "./support/revoke-server";

const server = revokeServerPerTest();

describe("POST /internal/revoke", () => {
  it(
    "closes the user's connections, and only theirs; nothing they edit after reaches the document",
    async () => {
      const { aOnX, aOnY, bOnX, dOnX } = await server.fixtureClients();

      expect(await server.revoke({ userId: USER_A })).toEqual({
        closedConnections: 2,
      });
      await closed([aOnX, aOnY]);
      expect(server.usersOn(X)).toEqual([USER_B, USER_D]);
      expect(server.usersOn(Y)).toEqual([]);

      appendParagraph(aOnX.doc, "edited after the revoke");
      appendParagraph(bOnX.doc, "edited by B");
      await waitFor(
        () => text(dOnX.doc).includes("edited by B"),
        "B's edit at D",
        WAIT_MS
      );
      await waitFor(
        () => server.serverText(X).includes("edited by B"),
        "B's edit on the server",
        WAIT_MS
      );
      expect(server.serverText(X)).not.toContain("edited after the revoke");
      expect(server.info()).toHaveBeenCalledWith("Doc sync revoke applied", {
        event: DOC_SYNC_REVOKE_APPLIED_EVENT,
        target: { userId: USER_A },
        closedConnections: 2,
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "refuses a token issued before the revoke as forbidden, and admits one issued after",
    async () => {
      const revokedAt = Date.now() - 5000;
      const before = await tokenIssuedAt(revokedAt - 5000, USER_A, ORG, SLUG_X);
      await server.connected(X, before);
      server.setClock(() => revokedAt);

      await server.revoke({ userId: USER_A });

      await expect(firstOutcome(server.open(X, () => before))).resolves.toEqual(
        {
          authenticated: false,
          reason: RealtimeErrorCode.Forbidden,
        }
      );
      const after = await tokenFor(USER_A, ORG, SLUG_X);
      await expect(firstOutcome(server.open(X, () => after))).resolves.toEqual({
        authenticated: true,
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "refuses a member who keeps access re-minting in an org revoke's second, and admits their next token on the same socket",
    async () => {
      const revokedAt = Date.now() - 5000;
      const tokens = [
        await tokenIssuedAt(revokedAt - 5000, USER_A, ORG, SLUG_X),
        await tokenIssuedAt(revokedAt, USER_A, ORG, SLUG_X),
        await tokenIssuedAt(revokedAt + 1000, USER_A, ORG, SLUG_X),
      ];
      const client = server.open(X, () => tokens.shift() ?? "");
      await expect(firstOutcome(client)).resolves.toEqual({
        authenticated: true,
      });
      server.setClock(() => revokedAt);

      await server.revoke({ orgId: ORG });
      await waitFor(
        () => client.authentications.length >= 2,
        "the reconnect's refusal",
        WAIT_MS
      );
      expect(client.authentications[1]).toEqual({
        authenticated: false,
        reason: RealtimeErrorCode.Forbidden,
      });

      // What DocSyncRoom does on a `forbidden` refusal: mint and authenticate again.
      await client.provider.sendToken();
      client.provider.startSync();

      await waitFor(
        () => client.authentications[2]?.authenticated === true,
        "the next token admitted",
        WAIT_MS
      );
      appendParagraph(client.doc, "edited after the revoke");
      await waitFor(
        () => server.serverText(X).includes("edited after the revoke"),
        "the edit on the server",
        WAIT_MS
      );
      expect(server.usersOn(X)).toEqual([USER_A]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "closes every connection in the org, and not another org's",
    async () => {
      const { aOnX, aOnY, bOnX, dOnX, cOnZ } = await server.fixtureClients();

      expect(await server.revoke({ orgId: ORG })).toEqual({
        closedConnections: 4,
      });
      await closed([aOnX, aOnY, bOnX, dOnX]);
      expect(server.usersOn(X)).toEqual([]);
      expect(server.usersOn(Y)).toEqual([]);
      expect(server.usersOn(Z)).toEqual([USER_C]);
      expect(cOnZ.closes).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "closes a document channel's connections, and not the same user's on another document",
    async () => {
      const { aOnX, aOnY, bOnX, dOnX } = await server.fixtureClients();

      expect(
        await server.revoke({
          channel: formatChannelAddress(ChannelKind.Document, ORG, [SLUG_X]),
        })
      ).toEqual({ closedConnections: 3 });
      await closed([aOnX, bOnX, dOnX]);
      expect(server.usersOn(X)).toEqual([]);
      expect(server.usersOn(Y)).toEqual([USER_A]);
      expect(aOnY.closes).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "closes the socket, so the provider reconnects and asks for a token again",
    async () => {
      const token = await tokenFor(USER_A, ORG, SLUG_X);
      const mint = vi.fn(() => token);
      const client = server.open(X, mint);
      await waitFor(
        () => client.authentications.length > 0,
        "authenticated",
        WAIT_MS
      );
      const statusesBefore = client.statuses.length;

      await server.revoke({ userId: USER_A });

      await waitFor(
        () => {
          const since = client.statuses.slice(statusesBefore);
          const disconnectedAt = since.indexOf("disconnected");
          return (
            disconnectedAt !== -1 &&
            since.slice(disconnectedAt).includes("connected")
          );
        },
        "a disconnect, then a reconnect",
        WAIT_MS
      );
      await waitFor(
        () => mint.mock.calls.length >= 2,
        "a second mint",
        WAIT_MS
      );
    },
    TEST_TIMEOUT_MS
  );
});

describe("POST /internal/documents/:documentName/disconnect", () => {
  it(
    "closes the document's connections and refuses none of their tokens",
    async () => {
      const { aOnX, aOnY, bOnX, dOnX } = await server.fixtureClients();
      const path = docSyncDocumentPath(X, DocSyncDocumentCommand.Disconnect);
      if (path === undefined) {
        throw new Error("X is not addressable");
      }

      const response = await server.internalPost(path);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ closedConnections: 3 });
      await closed([aOnX, bOnX, dOnX]);
      expect(aOnY.closes).toBe(0);
      await waitFor(
        () =>
          [aOnX, bOnX, dOnX].every(
            (client) =>
              client.authentications.filter((each) => each.authenticated)
                .length === 2
          ),
        "every provider admitted again with its pre-disconnect token",
        WAIT_MS
      );
      expect(server.usersOn(X)).toEqual([USER_A, USER_B, USER_D]);
      expect(server.info()).toHaveBeenCalledWith(
        "Doc sync disconnect applied",
        {
          event: DOC_SYNC_DISCONNECT_APPLIED_EVENT,
          documentName: X,
          closedConnections: 3,
        }
      );
    },
    TEST_TIMEOUT_MS
  );
});
