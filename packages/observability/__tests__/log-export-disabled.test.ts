// ISS-4399. DD_API_KEY has two unrelated consumers: this package's agentless
// log sink, and dd-trace's agentless Test Optimization reporter, which CI sets
// on every instrumented test lane. DD_LOGS_DISABLED lets a process that needs
// the key for the tracer keep the log sink shut, so the code under test does
// not ship its log calls to Datadog as if they were production traffic.
//
// Both branches are asserted here: without the flag the sink must still open
// (otherwise the flag would silently disable production logging), and with it
// the sink must stay shut even though the key is present.

import { afterEach, describe, expect, it, vi } from "vitest";
import { importLogWithFetch } from "./test-helpers";

// The package's vitest.setup.ts clears DD_LOGS_DISABLED for this suite, so each
// test sets exactly the value it is asserting on.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("DD_LOGS_DISABLED", () => {
  it("ships to the intake when the key is present and the flag is unset", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("export.enabled");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("http-intake.logs.");
  });

  it("does not ship when the flag is set, even with a key present", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_LOGS_DISABLED", "1");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("export.disabled");
    await log.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still writes to the console when the flag is set", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_LOGS_DISABLED", "1");

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // silence the sink under assertion
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("console.preserved");

    expect(infoSpy).toHaveBeenCalled();
  });

  it('accepts "true" and ignores other values', async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_LOGS_DISABLED", "true");

    const disabledFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const disabledLog = await importLogWithFetch(disabledFetch);
    disabledLog.info("export.disabled");
    await disabledLog.flush();
    expect(disabledFetch).not.toHaveBeenCalled();

    // "0", "false", "" and anything else leave the sink open — the flag is an
    // explicit opt-out, never an accidental one.
    vi.stubEnv("DD_LOGS_DISABLED", "0");
    const enabledFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const enabledLog = await importLogWithFetch(enabledFetch);
    enabledLog.info("export.enabled");
    await enabledLog.flush();
    expect(enabledFetch).toHaveBeenCalledTimes(1);
  });
});
