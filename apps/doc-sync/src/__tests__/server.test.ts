import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  createInternalOidcVerifier,
  type InternalOidcVerifier,
} from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  OIDC_JWKS_URL,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import { DOC_SYNC_INTERNAL_DOCUMENTS_PATH } from "@repo/realtime-contract/doc-sync-internal";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DOC_SYNC_CALLBACKS_NOT_CONFIGURED_EVENT } from "../callbacks/change-callbacks";
import { CommandOutcome } from "../commands/document-commands";
import {
  DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
  type DocSyncCallbackConfig,
} from "../env";
import { HealthPath } from "../http/health";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import type { DocumentStorage } from "../storage/document-storage";
import { DocSyncGauge, DocSyncHistogram } from "../telemetry/metrics";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { documentState } from "./support/documents";
import { memoryStorage } from "./support/memory-storage";
import { metricSamples } from "./support/metric-samples";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The list route (PLN-2200 T-3.10), the one `/internal` route that names no document. */
const INTERNAL_PROBE = DOC_SYNC_INTERNAL_DOCUMENTS_PATH;
const AUTH_TIMEOUT_MS = 5000;
/** Past the server's 2 s store debounce. */
const STORE_WAIT_MS = 8000;

let started: ReturnType<typeof createDocSyncServer> | undefined;

/** Persistence has its own Postgres-backed suite; these cases never store. */
const storage: DocumentStorage = {
  fetch: () => Promise.resolve(null),
  store: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  delete: () => Promise.resolve(false),
  listNames: () => Promise.resolve([]),
  close: () => Promise.resolve(),
  ping: () => Promise.resolve(),
};
let provider: HocuspocusProvider | undefined;
const namedProviders: HocuspocusProvider[] = [];

async function start(
  deps: Parameters<typeof createDocSyncServer>[2] = {},
  withStorage: DocumentStorage = storage,
  callbacks?: DocSyncCallbackConfig
): Promise<string> {
  started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
      callbacks,
    },
    withStorage,
    { flushLogs: () => Promise.resolve(), ...deps }
  );
  await started.server.listen();
  return `127.0.0.1:${started.server.address.port}`;
}

let fixture: OidcFixture;

beforeAll(async () => {
  fixture = await createOidcFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  provider?.destroy();
  provider = undefined;
  for (const each of namedProviders.splice(0)) {
    each.destroy();
  }
  await started?.shutdown();
  started = undefined;
});

type AuthOutcome = { authenticated: boolean; reason?: string };

function connect(host: string): Promise<AuthOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no authentication outcome")),
      AUTH_TIMEOUT_MS
    );
    const settle = (outcome: AuthOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    provider = new HocuspocusProvider({
      url: `ws://${host}`,
      name: "doc-1",
      token: "any-token",
      onAuthenticated: () => settle({ authenticated: true }),
      onAuthenticationFailed: ({ reason }) =>
        settle({ authenticated: false, reason }),
    });
  });
}

describe("createDocSyncServer", () => {
  it("answers GET /health 200 on the WebSocket port, uncached", async () => {
    const host = await start();

    const response = await fetch(`http://${host}${HealthPath.Health}`);

    expect(response.status).toBe(HTTP_OK);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("logs once that change callbacks are off when env.callbacks is unset", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await start();

    expect(
      warn.mock.calls.filter(
        ([, fields]) =>
          (fields as { event?: string } | undefined)?.event ===
          DOC_SYNC_CALLBACKS_NOT_CONFIGURED_EVENT
      )
    ).toHaveLength(1);
  });

  it("answers an unknown path 404, not Hocuspocus's welcome page", async () => {
    const host = await start();

    const response = await fetch(`http://${host}/unknown`);

    expect(response.status).toBe(HTTP_NOT_FOUND);
    expect(await response.text()).toBe("");
  });

  it("refuses a provider whose token does not verify, with the code as the reason", async () => {
    const host = await start();

    await expect(connect(host)).resolves.toEqual({
      authenticated: false,
      reason: RealtimeErrorCode.Unauthorized,
    });
  });

  it("admits a provider through an onAuthenticate override", async () => {
    const host = await start({ onAuthenticate: () => Promise.resolve() });

    await expect(connect(host)).resolves.toEqual({ authenticated: true });
  });

  it("refuses /internal/* with no bearer 401 unauthorized", async () => {
    const host = await start({ verifyInternalOidc: verifierServingJwks() });

    const response = await fetch(`http://${host}${INTERNAL_PROBE}`);

    expect(response.status).toBe(HTTP_UNAUTHORIZED);
    expect(await response.json()).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
  });

  it("refuses a token minted for another audience 401", async () => {
    const host = await start({ verifyInternalOidc: verifierServingJwks() });

    const response = await fetch(`http://${host}${INTERNAL_PROBE}`, {
      headers: bearer(await fixture.mint({ aud: "realtime-internal" })),
    });

    expect(response.status).toBe(HTTP_UNAUTHORIZED);
  });

  it("fails closed 503 while the JWKS is unavailable", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const host = await start({
      verifyInternalOidc: createInternalOidcVerifier(OIDC_CONFIG, {
        unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      }),
    });

    const response = await fetch(`http://${host}${INTERNAL_PROBE}`, {
      headers: bearer(await fixture.mint()),
    });

    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      })
    );
  });

  it("passes a valid token through to the routes", async () => {
    const host = await start({ verifyInternalOidc: verifierServingJwks() });

    const response = await fetch(`http://${host}${INTERNAL_PROBE}`, {
      headers: bearer(await fixture.mint()),
    });

    expect(response.status).toBe(HTTP_OK);
    expect(await response.json()).toEqual({ names: [], nextAfter: null });
  });

  it("verifies against env.internalOidc by default", async () => {
    const realFetch = globalThis.fetch;
    const jwks = fixture.servingJwks();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === OIDC_JWKS_URL
        ? jwks(input, init)
        : realFetch(input, init)
    );
    const host = await start();

    const valid = await fetch(`http://${host}${INTERNAL_PROBE}`, {
      headers: bearer(await fixture.mint()),
    });
    const wrongProject = await fetch(`http://${host}${INTERNAL_PROBE}`, {
      headers: bearer(await fixture.mint({ project_id: "prj_other" })),
    });

    expect(valid.status).toBe(HTTP_OK);
    expect(wrongProject.status).toBe(HTTP_UNAUTHORIZED);
    expect(jwks).toHaveBeenCalled();
  });
});

describe("createDocSyncServer hooks and gauges", () => {
  it("refuses only the document whose load fails; another authenticates and syncs", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: DocumentStorage = {
      ...storage,
      fetch: (name) =>
        name === LOAD_FAILS
          ? Promise.reject(new Error("fetch failed"))
          : Promise.resolve(null),
    };
    const host = await start(
      { onAuthenticate: () => Promise.resolve() },
      failing
    );

    const [refusal, admitted] = await Promise.all([
      refusalOn(host, LOAD_FAILS),
      connectTo(host, LOADS),
    ]);
    admitted.provider.document.getMap("m").set("k", "synced");

    // Hocuspocus 4.7.0 admits the connection, then refuses it once the load fails.
    expect(refusal).toBe(LOAD_REFUSAL_REASON);
    expect(admitted.outcome).toEqual({ authenticated: true });
    await vi.waitFor(
      () =>
        expect(
          started?.server.hocuspocus.documents.get(LOADS)?.getMap("m").get("k")
        ).toBe("synced"),
      { timeout: AUTH_TIMEOUT_MS }
    );
  });

  it("refuses a provider whose afterLoadDocument fails, rather than serving the document", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = await start({
      onAuthenticate: () => Promise.resolve(),
      extensions: [
        {
          afterLoadDocument: ({ documentName }) =>
            documentName === LOAD_FAILS
              ? Promise.reject(new Error("after load failed"))
              : Promise.resolve(),
        },
      ],
    });

    const [refusal, admitted] = await Promise.all([
      refusalOn(host, LOAD_FAILS),
      connectTo(host, LOADS),
    ]);

    expect(refusal).toBe(LOAD_REFUSAL_REASON);
    expect(admitted.outcome).toEqual({ authenticated: true });
    expect(started?.server.hocuspocus.documents.has(LOAD_FAILS)).toBe(false);
  });

  it("samples a store's duration through the server's storage", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const { storage: seeded } = memoryStorage([
      [LOADS, documentState("stored text")],
    ]);
    await start({}, seeded);

    await expect(started?.commands.clear(LOADS)).resolves.toEqual({
      kind: CommandOutcome.Done,
      cleared: true,
    });

    await vi.waitFor(
      () =>
        expect(metricSamples(info)).toContainEqual(
          expect.objectContaining({ metric: DocSyncHistogram.StoreDurationMs })
        ),
      { timeout: AUTH_TIMEOUT_MS }
    );
  });

  it("a change landing while a store is in flight sends its own callback after its own store", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        sent.push(String(init.body));
        return Promise.resolve(new Response(null, { status: 202 }));
      })
    );
    const { storage: memory } = memoryStorage();
    let releaseFirstStore: (() => void) | undefined;
    const held: DocumentStorage = {
      ...memory,
      store: (name, state) => {
        if (releaseFirstStore !== undefined) {
          return memory.store(name, state);
        }
        return new Promise<void>((resolve) => {
          releaseFirstStore = resolve;
        }).then(() => memory.store(name, state));
      },
    };
    const host = await start(
      {
        onAuthenticate: () => Promise.resolve(),
        signChangeCallback: () => Promise.resolve({}),
      },
      held,
      { url: "https://api.test", region: "us-east-1" }
    );
    const { provider: editor } = await connectTo(host, LOADS);
    const doc = started?.server.hocuspocus.documents;

    editor.document.getMap("m").set("k", "first");
    await vi.waitFor(() => expect(releaseFirstStore).toBeDefined(), {
      timeout: STORE_WAIT_MS,
    });
    editor.document.getMap("m").set("k", "second");
    await vi.waitFor(
      () => expect(doc?.get(LOADS)?.getMap("m").get("k")).toBe("second"),
      { timeout: AUTH_TIMEOUT_MS }
    );
    releaseFirstStore?.();

    await vi.waitFor(() => expect(sent).toHaveLength(2), {
      timeout: STORE_WAIT_MS,
    });
  }, 20_000);

  it("reports the open-document gauge from the running server", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const host = await start({
      onAuthenticate: () => Promise.resolve(),
      gaugeIntervalMs: GAUGE_INTERVAL_MS,
    });

    const { outcome } = await connectTo(host, LOADS);

    expect(outcome).toEqual({ authenticated: true });
    await vi.waitFor(
      () =>
        expect(metricSamples(info)).toContainEqual(
          expect.objectContaining({
            metric: DocSyncGauge.OpenDocuments,
            value: 1,
          })
        ),
      { timeout: AUTH_TIMEOUT_MS }
    );
  });
});

const LOAD_FAILS = "doc-load-fails";
/** Hocuspocus's reason for a refused connection whose error carries none. */
const LOAD_REFUSAL_REASON = "permission-denied";
const LOADS = "doc-loads";
const GAUGE_INTERVAL_MS = 50;

/** A provider on `name`, resolved with its authentication outcome. */
function connectTo(
  host: string,
  name: string
): Promise<{ provider: HocuspocusProvider; outcome: AuthOutcome }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no authentication outcome for ${name}`)),
      AUTH_TIMEOUT_MS
    );
    const settle = (outcome: AuthOutcome) => {
      clearTimeout(timer);
      resolve({ provider: named, outcome });
    };
    const named = new HocuspocusProvider({
      url: `ws://${host}`,
      name,
      token: "any-token",
      onAuthenticated: () => settle({ authenticated: true }),
      onAuthenticationFailed: ({ reason }) =>
        settle({ authenticated: false, reason }),
    });
    namedProviders.push(named);
  });
}

/** A provider on `name`, resolved with the reason it is refused, even after admission. */
function refusalOn(host: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no refusal for ${name}`)),
      AUTH_TIMEOUT_MS
    );
    namedProviders.push(
      new HocuspocusProvider({
        url: `ws://${host}`,
        name,
        token: "any-token",
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          resolve(reason);
        },
      })
    );
  });
}

function verifierServingJwks(): InternalOidcVerifier {
  return createInternalOidcVerifier(OIDC_CONFIG, {
    unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
    fetch: fixture.servingJwks(),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
