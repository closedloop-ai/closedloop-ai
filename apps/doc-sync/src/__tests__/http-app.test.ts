import { Hocuspocus } from "@hocuspocus/server";
import {
  InternalOidcVerdict,
  type InternalOidcVerifier,
} from "@repo/http-service/internal-oidc";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { createRevocations } from "@repo/realtime-contract/revocations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionControl } from "../commands/connection-control";
import { createDocumentCommands } from "../commands/document-commands";
import { createNeverStoredTracker } from "../commands/first-open-seed";
import {
  createDocSyncHttpApp,
  FIRST_OPEN_SEED_REQUEST_BURST,
  INTERNAL_REQUEST_BURST,
} from "../http/app";
import { HealthPath } from "../http/health";
import type { HealthVerdict } from "../http/health-probe";
import { createTombstones } from "../storage/tombstones";
import { memoryStorage } from "./support/memory-storage";

const verifyOidc = vi.fn<InternalOidcVerifier>(() =>
  Promise.resolve({ verdict: InternalOidcVerdict.Verified })
);

function appWithHealth(verdict: HealthVerdict) {
  const hocuspocus = new Hocuspocus();
  return createDocSyncHttpApp({
    verifyOidc,
    commands: createDocumentCommands({
      hocuspocus,
      storage: memoryStorage().storage,
      tombstones: createTombstones(),
      neverStored: createNeverStoredTracker(),
    }).commands,
    health: { check: () => Promise.resolve(verdict) },
    connections: createConnectionControl({
      hocuspocus,
      revocations: createRevocations(),
    }),
  });
}

const app = appWithHealth({ ok: true });

describe("createDocSyncHttpApp", () => {
  it("answers GET /health with a query string 200, as uncached JSON", async () => {
    const response = await app.request(`${HealthPath.Health}?probe=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(JSON.stringify({ ok: true }));
  });

  it("answers GET /health 503 while the probe reports the database down", async () => {
    const response = await appWithHealth({ ok: false }).request(
      HealthPath.Health
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(JSON.stringify({ ok: false }));
  });

  it.each(["POST", "HEAD"])(
    "answers %s /health an empty 404",
    async (method) => {
      const response = await app.request(HealthPath.Health, { method });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  );
});

const FIRST_OPEN_SEED_PROBE =
  docSyncDocumentPath(
    generateDocumentRoomId("0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f", "PLN-1"),
    DocSyncDocumentCommand.FirstOpenSeed
  ) ?? "";
const AUTHORIZED: RequestInit = {
  headers: { authorization: "Bearer token" },
};

describe("the /internal rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      spent: "the first-open seed's",
      drained: FIRST_OPEN_SEED_PROBE,
      other: DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
      burst: FIRST_OPEN_SEED_REQUEST_BURST,
    },
    {
      spent: "every other command's",
      drained: DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
      other: FIRST_OPEN_SEED_PROBE,
      burst: INTERNAL_REQUEST_BURST,
    },
  ])(
    "spending $spent bucket answers it 429 and still serves the other",
    async ({ drained, other, burst }) => {
      const app = appWithHealth({ ok: true });
      for (let sent = 0; sent < burst; sent += 1) {
        expect((await app.request(drained, AUTHORIZED)).status).toBe(200);
      }

      expect((await app.request(drained, AUTHORIZED)).status).toBe(429);
      expect((await app.request(other, AUTHORIZED)).status).toBe(200);
    }
  );
});
