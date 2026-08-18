// ISS-5261. The agentless log sink builds `https://http-intake.logs.${DD_SITE}
// /api/v2/logs` and attaches DD-API-KEY, so an unrecognised DD_SITE sends both
// the key and the contents of every buffered log line to whatever that value
// resolves to. `telemetry/series.ts` allowlisted its own sender first; an
// allowlist that covers one Datadog sender and not the other is not a control,
// it just moves which request leaks the key.
//
// The failure this pins is specifically a userinfo authority:
// `https://http-intake.logs.datadoghq.com@attacker.example/...` is a valid URL
// whose HOST is attacker.example. Prefix or substring matching accepts it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { importLogWithFetch } from "./test-helpers";

const API_KEY = "dd-api-key-value";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {
    // the sink under assertion
  });
}

describe("log export site allowlist", () => {
  it.each([
    ["datadoghq.com@attacker.example", "userinfo authority"],
    ["evil.example", "unknown host"],
    ["datadoghq.com.attacker.example", "suffix extension"],
    ["DATADOGHQ.COM", "case variant"],
    ["datadoghq.com:8443", "port suffix"],
  ])("ships nothing when DD_SITE is %s (%s)", async (site) => {
    vi.stubEnv("DD_API_KEY", API_KEY);
    vi.stubEnv("DD_SITE", site);
    silenceConsoleError();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("must.not.egress");
    await log.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the refusal without routing it through the refused sink", async () => {
    vi.stubEnv("DD_API_KEY", API_KEY);
    vi.stubEnv("DD_SITE", "datadoghq.com@attacker.example");
    const errorSpy = silenceConsoleError();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await importLogWithFetch(fetchMock);

    // Local only. Reporting via this module's own log.* would queue the notice
    // for the very sink being refused.
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("log export disabled");
    // The refusal notice must not carry the key it is protecting.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(API_KEY);
  });

  it("still writes to the console when the sink is closed by the allowlist", async () => {
    // Closing the sink must not cost local observability — otherwise a
    // misconfigured site would make the process silent instead of merely
    // non-exporting.
    vi.stubEnv("DD_API_KEY", API_KEY);
    vi.stubEnv("DD_SITE", "evil.example");
    silenceConsoleError();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // silence
    });

    const log = await importLogWithFetch(
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    log.info("console.preserved");

    expect(infoSpy).toHaveBeenCalled();
  });

  it("ships to an allowed site, so the guard is not vacuous", async () => {
    // Without this, deleting the allowlist call entirely would leave the suite
    // above green only because nothing ever shipped.
    vi.stubEnv("DD_API_KEY", API_KEY);
    vi.stubEnv("DD_SITE", "datadoghq.eu");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("export.enabled");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://http-intake.logs.datadoghq.eu/api/v2/logs"
    );
  });

  it("refuses redirects, so a 307 cannot replay the batch and key elsewhere", async () => {
    vi.stubEnv("DD_API_KEY", API_KEY);
    vi.stubEnv("DD_SITE", "datadoghq.com");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const log = await importLogWithFetch(fetchMock);

    log.info("redirect.refused");
    await log.flush();

    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });
});
