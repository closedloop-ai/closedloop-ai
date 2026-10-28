import { HocuspocusProvider } from "@hocuspocus/provider";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { createInternalOidcVerifier } from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { DOC_SYNC_REVOKE_PATH } from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { GrantAccess } from "@repo/realtime-contract/grants";
import type { RevokeTarget } from "@repo/realtime-contract/internal";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { Doc } from "yjs";
import { docSyncConnectionContextSchema } from "../../auth/connection-hooks";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../../env";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../../server";
import { ORG, OTHER_ORG, PUBLIC_KEYS, signToken } from "../auth/test-tokens";
import { waitFor } from "../integration/test-schema";
import { memoryStorage } from "./memory-storage";

export const WAIT_MS = 5000;
export const TEST_TIMEOUT_MS = 20_000;
export const SLUG_X = "PLN-1";
export const X = generateDocumentRoomId(ORG, SLUG_X);
export const Y = generateDocumentRoomId(ORG, "PLN-2");
export const Z = generateDocumentRoomId(OTHER_ORG, "PLN-3");
export const USER_A = "user-a";
export const USER_B = "user-b";
export const USER_C = "user-c";
export const USER_D = "user-d";

export type Client = {
  provider: HocuspocusProvider;
  doc: Doc;
  closes: number;
  statuses: string[];
  authentications: { authenticated: boolean; reason?: string }[];
};

/**
 * A real doc-sync server on an ephemeral port per test, with the internal
 * OIDC check served by a fixture, an injectable clock, and storage whose
 * fetch a test can hold to keep a document mid-load.
 */
export function revokeServerPerTest() {
  let fixture: OidcFixture | undefined;
  let started: ReturnType<typeof createDocSyncServer> | undefined;
  let port = 0;
  let clock: () => number = Date.now;
  let fetchHeld: Promise<void> = Promise.resolve();
  let releaseFetch: () => void = () => undefined;
  const clients: Client[] = [];
  let info: ReturnType<typeof vi.spyOn<typeof log, "info">> | undefined;

  beforeAll(async () => {
    fixture = await createOidcFixture();
  });

  beforeEach(async () => {
    clock = Date.now;
    fetchHeld = Promise.resolve();
    info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const { storage } = memoryStorage();
    started = createDocSyncServer(
      {
        port: 0,
        shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
        tokenPublicKeys: PUBLIC_KEYS,
        allowedOrigins: [],
        internalOidc: OIDC_CONFIG,
      },
      {
        ...storage,
        fetch: async (name) => {
          await fetchHeld;
          return storage.fetch(name);
        },
      },
      {
        verifyInternalOidc: createInternalOidcVerifier(OIDC_CONFIG, {
          unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
          fetch: requireFixture().servingJwks(),
        }),
        flushLogs: () => Promise.resolve(),
        now: () => clock(),
      }
    );
    await started.server.listen();
    port = started.server.address.port;
  });

  afterEach(async () => {
    releaseFetch();
    vi.useRealTimers();
    for (const { provider } of clients.splice(0)) {
      provider.configuration.websocketProvider.destroy();
      provider.destroy();
    }
    await started?.shutdown();
    started = undefined;
    vi.restoreAllMocks();
  });

  function requireFixture(): OidcFixture {
    if (!fixture) {
      throw new Error("the OIDC fixture is not ready");
    }
    return fixture;
  }

  /** A provider on its own socket, as `DocSyncRoom` builds one; `token` runs on every authentication. */
  function open(name: string, token: () => Promise<string> | string): Client {
    const doc = new Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name,
      document: doc,
      token,
    });
    const client: Client = {
      provider,
      doc,
      closes: 0,
      statuses: [],
      authentications: [],
    };
    provider.on("close", () => {
      client.closes += 1;
    });
    provider.on("status", ({ status }: { status: string }) => {
      client.statuses.push(status);
    });
    provider.on("authenticated", () => {
      client.authentications.push({ authenticated: true });
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      client.authentications.push({ authenticated: false, reason });
    });
    clients.push(client);
    return client;
  }

  async function connected(name: string, token: string): Promise<Client> {
    const client = open(name, () => token);
    await waitFor(
      () => client.authentications.length > 0,
      `${name} authenticated`,
      WAIT_MS
    );
    if (!client.authentications[0]?.authenticated) {
      throw new Error(`${name} refused the fixture's token`);
    }
    return client;
  }

  async function internalPost(path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await requireFixture().mint()}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** The user ids connected to `name` on the server, sorted. */
  function usersOn(name: string): string[] {
    const document = started?.server.hocuspocus.documents.get(name);
    return (document?.getConnections() ?? [])
      .map(
        (connection) =>
          docSyncConnectionContextSchema.parse(connection.context).userId
      )
      .sort();
  }

  function serverText(name: string): string {
    return (
      started?.server.hocuspocus.documents
        .get(name)
        ?.getXmlFragment(DOCUMENT_FRAGMENT_FIELD)
        .toString() ?? ""
    );
  }

  return {
    info: () => info,
    setClock: (next: () => number) => {
      clock = next;
    },
    /** Holds every storage fetch until the returned function runs. */
    holdLoads: (): (() => void) => {
      fetchHeld = new Promise((resolve) => {
        releaseFetch = resolve;
      });
      return () => releaseFetch();
    },
    isLoading: (name: string) =>
      started?.server.hocuspocus.loadingDocuments.has(name) === true,
    open,
    connected,
    internalPost,
    async revoke(target: RevokeTarget): Promise<unknown> {
      const response = await internalPost(DOC_SYNC_REVOKE_PATH, { target });
      if (response.status !== 200) {
        throw new Error(`revoke answered ${response.status}`);
      }
      return response.json();
    },
    usersOn,
    serverText,
    async fixtureClients() {
      return {
        aOnX: await connected(X, await tokenFor(USER_A, ORG, SLUG_X)),
        aOnY: await connected(Y, await tokenFor(USER_A, ORG, "PLN-2")),
        bOnX: await connected(X, await tokenFor(USER_B, ORG, SLUG_X)),
        dOnX: await connected(X, await tokenFor(USER_D, ORG, SLUG_X)),
        cOnZ: await connected(Z, await tokenFor(USER_C, OTHER_ORG, "PLN-3")),
      };
    },
  };
}

/** A token granting `slug`'s document at write, issued to `sub` in `org`, now. */
export function tokenFor(
  sub: string,
  org: string,
  slug: string
): Promise<string> {
  return signToken({
    sub,
    org,
    grants: [
      {
        pattern: formatChannelAddress(ChannelKind.Document, org, [slug]),
        access: GrantAccess.Write,
      },
    ],
  });
}

/** The same token, issued at `issuedAtMs`. */
export async function tokenIssuedAt(
  issuedAtMs: number,
  sub: string,
  org: string,
  slug: string
): Promise<string> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(issuedAtMs);
  try {
    return await tokenFor(sub, org, slug);
  } finally {
    vi.useRealTimers();
  }
}

export async function firstOutcome(client: Client) {
  await waitFor(
    () => client.authentications.length > 0,
    "an authentication outcome",
    WAIT_MS
  );
  return client.authentications[0];
}

export function text(doc: Doc): string {
  return doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD).toString();
}

export async function closed(each: Client[]): Promise<void> {
  await waitFor(
    () => each.every((client) => client.closes > 0),
    "the closes",
    WAIT_MS
  );
}
