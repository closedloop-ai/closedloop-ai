import { Hocuspocus } from "@hocuspocus/server";
import {
  InternalOidcVerdict,
  type InternalOidcVerifier,
} from "@repo/http-service/internal-oidc";
import { log } from "@repo/observability/log";
import { Origin } from "@repo/observability/telemetry/origin";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DOC_SYNC_REVOKE_PATH,
  DocSyncDocumentCommand,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { createRevocations } from "@repo/realtime-contract/revocations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectionControl,
  type DocSyncConnectionControl,
} from "../commands/connection-control";
import {
  CommandOutcome,
  createDocumentCommands,
  type DocSyncCommands,
} from "../commands/document-commands";
import { createNeverStoredTracker } from "../commands/first-open-seed";
import { createDocSyncHttpApp } from "../http/app";
import {
  DOC_SYNC_INTERNAL_COMMAND_FAILED_EVENT,
  InternalCommandLabel,
} from "../http/command-outcome";
import { HealthPath } from "../http/health";
import { createTombstones } from "../storage/tombstones";
import { DocSyncCount } from "../telemetry/metrics";
import { memoryStorage } from "./support/memory-storage";
import { metricSamples } from "./support/metric-samples";

const NAME = generateDocumentRoomId(
  "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  "PLN-1"
);
const SEED_BODY = JSON.stringify({ markdown: "# Title", version: 2 });

let info: ReturnType<typeof spyInfo>;
let error: ReturnType<typeof spyError>;

function spyInfo() {
  return vi.spyOn(log, "info").mockImplementation(() => undefined);
}

function spyError() {
  return vi.spyOn(log, "error").mockImplementation(() => undefined);
}

beforeEach(() => {
  info = spyInfo();
  error = spyError();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function app(
  overrides: Partial<DocSyncCommands> = {},
  verdict: InternalOidcVerdict = InternalOidcVerdict.Verified,
  healthy = true,
  connectionOverrides: Partial<DocSyncConnectionControl> = {}
) {
  const verifyOidc = vi.fn<InternalOidcVerifier>(() =>
    Promise.resolve({ verdict })
  );
  const hocuspocus = new Hocuspocus();
  const { commands } = createDocumentCommands({
    hocuspocus,
    storage: memoryStorage().storage,
    tombstones: createTombstones(),
    neverStored: createNeverStoredTracker(),
  });
  const connections = createConnectionControl({
    hocuspocus,
    revocations: createRevocations(),
  });
  return createDocSyncHttpApp({
    verifyOidc,
    commands: { ...commands, ...overrides },
    health: { check: () => Promise.resolve({ ok: healthy }) },
    connections: { ...connections, ...connectionOverrides },
  });
}

function pathOf(command?: DocSyncDocumentCommand): string {
  const path = docSyncDocumentPath(NAME, command);
  if (path === undefined) {
    throw new Error(`${NAME} is not addressable`);
  }
  return path;
}

function request(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { authorization: "Bearer token", ...init.headers },
  };
}

function failureCounts() {
  return metricSamples(info).filter(
    (sample) => sample.metric === DocSyncCount.InternalCommandFailures
  );
}

function failureLogs() {
  return error.mock.calls.filter(
    ([message]) => message === "Doc sync internal command failed"
  );
}

describe("recordInternalCommandOutcome", () => {
  it("counts a labelled route answering 503 under its command", async () => {
    const response = await app({
      deleteDocument: () =>
        Promise.resolve({ kind: CommandOutcome.UnloadTimeout }),
    }).request(pathOf(), request({ method: "DELETE" }));

    expect(response.status).toBe(503);
    expect(failureCounts()).toEqual([
      {
        metric: DocSyncCount.InternalCommandFailures,
        count: 1,
        command: InternalCommandLabel.Delete,
        httpStatus: 503,
        origin: Origin.DocSync,
        _telemetryMetric: true,
      },
    ]);
    expect(failureLogs()).toEqual([
      [
        "Doc sync internal command failed",
        {
          event: DOC_SYNC_INTERNAL_COMMAND_FAILED_EVENT,
          command: InternalCommandLabel.Delete,
          status: 503,
        },
      ],
    ]);
  });

  it("counts a failed seed-version under seed_version", async () => {
    const response = await app({
      seedVersion: () => Promise.resolve({ kind: CommandOutcome.SeedFailed }),
    }).request(
      pathOf(DocSyncDocumentCommand.SeedVersion),
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: SEED_BODY,
      })
    );

    expect(response.status).toBe(500);
    expect(failureCounts()).toEqual([
      expect.objectContaining({
        command: InternalCommandLabel.SeedVersion,
        httpStatus: 500,
      }),
    ]);
  });

  it("counts a failed first-open seed under seed_if_never_stored", async () => {
    const response = await app({
      seedIfNeverStored: () =>
        Promise.resolve({ kind: CommandOutcome.SeedFailed }),
    }).request(
      pathOf(DocSyncDocumentCommand.SeedIfNeverStored),
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: SEED_BODY,
      })
    );

    expect(response.status).toBe(500);
    expect(failureCounts()).toEqual([
      expect.objectContaining({
        command: InternalCommandLabel.SeedIfNeverStored,
        httpStatus: 500,
      }),
    ]);
  });

  it("counts nothing for a 4xx", async () => {
    const response = await app().request(
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/not-canonical/${DocSyncDocumentCommand.Clear}`,
      request({ method: "POST" })
    );

    expect(response.status).toBe(400);
    expect(failureCounts()).toEqual([]);
    expect(failureLogs()).toEqual([]);
  });

  it("counts a throwing command, answered 500 by the error handler", async () => {
    const response = await app({
      clear: () => Promise.reject(new Error("clear failed")),
    }).request(
      pathOf(DocSyncDocumentCommand.Clear),
      request({ method: "POST" })
    );

    expect(response.status).toBe(500);
    expect(failureCounts()).toEqual([
      expect.objectContaining({
        command: InternalCommandLabel.Clear,
        httpStatus: 500,
      }),
    ]);
  });

  it("counts a throwing revoke under revoke", async () => {
    const response = await app({}, InternalOidcVerdict.Verified, true, {
      revoke: () => {
        throw new Error("revoke failed");
      },
    }).request(
      DOC_SYNC_REVOKE_PATH,
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: { userId: "user-1" } }),
      })
    );

    expect(response.status).toBe(500);
    expect(failureCounts()).toEqual([
      expect.objectContaining({
        command: InternalCommandLabel.Revoke,
        httpStatus: 500,
      }),
    ]);
  });

  it("counts a throwing disconnect under disconnect", async () => {
    const response = await app({}, InternalOidcVerdict.Verified, true, {
      disconnectDocument: () => {
        throw new Error("disconnect failed");
      },
    }).request(
      pathOf(DocSyncDocumentCommand.Disconnect),
      request({ method: "POST" })
    );

    expect(response.status).toBe(500);
    expect(failureCounts()).toEqual([
      expect.objectContaining({
        command: InternalCommandLabel.Disconnect,
        httpStatus: 500,
      }),
    ]);
  });

  it("counts a refusal at the OIDC check as unrouted", async () => {
    const response = await app({}, InternalOidcVerdict.Unavailable).request(
      DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
      request()
    );

    expect(response.status).toBe(503);
    expect(failureCounts()).toEqual([
      expect.objectContaining({
        command: InternalCommandLabel.Unrouted,
        httpStatus: 503,
      }),
    ]);
  });

  it("counts nothing for GET /health", async () => {
    const response = await app({}, InternalOidcVerdict.Verified, false).request(
      HealthPath.Health
    );

    expect(response.status).toBe(503);
    expect(failureCounts()).toEqual([]);
  });
});
