import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Extension, Server } from "@hocuspocus/server";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { DOC_SYNC_HOOK_FAILED_EVENT } from "../hooks/hook-guard";
import { HealthPath } from "../http/health";
import { createDocSyncServer } from "../server";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { memoryStorage } from "./support/memory-storage";

const THROWING = "doc-a";
const HEALTHY = "doc-b";
const WAIT = { timeout: 5000 };

let started: { server: Server; shutdown: () => Promise<void> } | undefined;
const providers: HocuspocusProvider[] = [];
const unhandled = vi.fn();

beforeEach(() => {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  process.on("unhandledRejection", unhandled);
});

afterEach(async () => {
  process.off("unhandledRejection", unhandled);
  unhandled.mockReset();
  for (const provider of providers.splice(0)) {
    provider.configuration.websocketProvider.destroy();
    provider.destroy();
  }
  await started?.shutdown();
  started = undefined;
  vi.restoreAllMocks();
});

/** Every hook a client can drive after admission throws, for {@link THROWING} only. */
function throwingFor(documentName: string): Extension {
  const fail = (name: string) => {
    if (name === documentName) {
      return Promise.reject(new Error(`hook failed for ${name}`));
    }
    return Promise.resolve();
  };
  return {
    onChange: ({ documentName: name }) => fail(name),
    onStateless: ({ document }) => fail(document.name),
    onDisconnect: ({ documentName: name }) => fail(name),
    beforeUnloadDocument: ({ documentName: name }) => fail(name),
    afterUnloadDocument: ({ documentName: name }) => fail(name),
  };
}

async function start(): Promise<string> {
  started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    memoryStorage().storage,
    {
      onAuthenticate: () => Promise.resolve(),
      flushLogs: () => Promise.resolve(),
      extensions: [throwingFor(THROWING)],
    }
  );
  await started.server.listen();
  return `127.0.0.1:${started.server.address.port}`;
}

/** A provider with its own socket, resolved once it has synced. */
function connect(host: string, name: string): Promise<HocuspocusProvider> {
  return new Promise((resolve) => {
    const provider = new HocuspocusProvider({
      url: `ws://${host}`,
      name,
      token: "any-token",
      onSynced: () => resolve(provider),
    });
    providers.push(provider);
  });
}

function disconnect(provider: HocuspocusProvider): void {
  providers.splice(providers.indexOf(provider), 1);
  provider.configuration.websocketProvider.destroy();
  provider.destroy();
}

/** The hook named by each `doc_sync.hook_failed` line. */
function failedHooks(): unknown[] {
  return vi
    .mocked(log.error)
    .mock.calls.flatMap(([, fields]) =>
      typeof fields === "object" &&
      fields !== null &&
      "event" in fields &&
      fields.event === DOC_SYNC_HOOK_FAILED_EVENT &&
      "hook" in fields
        ? [fields.hook]
        : []
    );
}

describe("a throwing hook", () => {
  it("rejects nothing unhandled, leaves other documents syncing, and still unloads its document", async () => {
    const host = await start();
    const server = started?.server;
    const throwing = await connect(host, THROWING);
    const writer = await connect(host, HEALTHY);
    const reader = await connect(host, HEALTHY);

    throwing.document.getMap("m").set("k", "edit");
    throwing.sendStateless("ping");
    await vi.waitFor(
      () => expect(failedHooks()).toEqual(["onChange", "onStateless"]),
      WAIT
    );

    writer.document.getMap("m").set("k", "synced");
    await vi.waitFor(
      () => expect(reader.document.getMap("m").get("k")).toBe("synced"),
      WAIT
    );
    const health = await fetch(`http://${host}${HealthPath.Health}`);
    expect(health.status).toBe(200);

    disconnect(throwing);
    await vi.waitFor(
      () => expect(server?.hocuspocus.documents.has(THROWING)).toBe(false),
      WAIT
    );
    expect(server?.hocuspocus.documents.has(HEALTHY)).toBe(true);
    await vi.waitFor(
      () =>
        expect(new Set(failedHooks())).toEqual(
          new Set([
            "onChange",
            "onStateless",
            "onDisconnect",
            "beforeUnloadDocument",
            "afterUnloadDocument",
          ])
        ),
      WAIT
    );
    expect(unhandled).not.toHaveBeenCalled();
  }, 15_000);
});
