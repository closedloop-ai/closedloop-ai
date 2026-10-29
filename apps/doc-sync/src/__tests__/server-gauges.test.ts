import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer } from "../server";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { memoryStorage } from "./support/memory-storage";

const gauges = vi.hoisted(() => {
  const stop = vi.fn();
  return { stop, start: vi.fn(() => stop) };
});

vi.mock("../telemetry/gauges", () => ({
  startGaugeReporter: gauges.start,
}));

describe("createDocSyncServer gauge reporter", () => {
  it("starts at the configured interval and stops at shutdown", async () => {
    const { shutdown } = createDocSyncServer(
      {
        port: 0,
        shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
        tokenPublicKeys: PUBLIC_KEYS,
        allowedOrigins: [],
        internalOidc: OIDC_CONFIG,
      },
      memoryStorage().storage,
      { flushLogs: () => Promise.resolve(), gaugeIntervalMs: 250 }
    );

    expect(gauges.start).toHaveBeenCalledWith(
      {
        openDocuments: expect.any(Function),
        connections: expect.any(Function),
      },
      250
    );
    expect(gauges.stop).not.toHaveBeenCalled();

    await shutdown();

    expect(gauges.stop).toHaveBeenCalledTimes(1);
  });
});
