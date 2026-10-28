/**
 * ISS-12394: `collect` branches the sibling suite leaves open: the wait for
 * the Collector's hold, and a run whose two paths agree (PARITY, no re-run
 * hint inside the live window). ISS-12605: a run whose only findings are not
 * missing records gets no re-run hint.
 */
import type * as ChildProcessModule from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParityFindingKind } from "../scripts/otlp-egress-parity-diff.js";
import { collect } from "../scripts/otlp-egress-parity-proof.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFileSync: vi.fn(() => JSON.stringify({ data: [] })),
}));

const RELAY_RUN_ID = "620a2a70-8516-43e7-a35d-b3419be83639";
const ROUTE_RUN_ID = "c34b8025-853e-40c0-afeb-a6fe0694721c";
const SENT_AT = "2026-10-09T21:14:27.000Z";
const SENT_AT_MS = Date.parse(SENT_AT);
const RELAY_RUN_ID_PATTERN = new RegExp(RELAY_RUN_ID, "g");
const WAITING_LINE = /^waiting (\d+) s for the Collector$/;

const relayHitsText = readFileSync(
  join(import.meta.dirname, "fixtures/otlp-egress-parity/relay-hits.json"),
  "utf8"
);

const outDirs: string[] = [];

afterEach(() => {
  for (const dir of outDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(() =>
    JSON.stringify({ data: [] })
  );
});

describe("collect", () => {
  it("waits out the Collector hold before searching when called too early", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    // 10 s after the last export: the 315 s hold has ~305 s left.
    vi.setSystemTime(SENT_AT_MS + 10_000);
    const outDir = writeRunFile();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const pending = collect(outDir);
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileSync).not.toHaveBeenCalled();
    const waiting = log.mock.calls
      .map((args) => String(args[0]))
      .find((line) => WAITING_LINE.test(line));
    expect(waiting).toBe("waiting 305 s for the Collector");

    await vi.runAllTimersAsync();
    expect(await pending).toBe(false);
    expect(execFileSync).toHaveBeenCalled();
  });

  it("reports PARITY with no re-run hint when both paths return the same records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SENT_AT_MS + 6 * 60_000);
    const relay = JSON.parse(relayHitsText);
    const route = JSON.parse(
      relayHitsText.replace(RELAY_RUN_ID_PATTERN, ROUTE_RUN_ID)
    );
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = (args ?? []).map(String);
      const hits = argv.some((arg) => arg.includes(ROUTE_RUN_ID))
        ? route
        : relay;
      const data = argv[1] === "traces" ? hits.spans : hits.logs;
      return JSON.stringify({ data });
    });
    const outDir = writeRunFile();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const passed = await collect(outDir);
    const lines = log.mock.calls.map((args) => String(args[0]));

    expect(passed).toBe(true);
    expect(lines.at(-1)).toBe("PARITY");
    expect(lines).toContain("span search: live");
    expect(lines.some((line) => line.startsWith("FINDING"))).toBe(false);
    expect(lines.some((line) => line.startsWith("records may still be"))).toBe(
      false
    );
  });

  it("gives no re-run hint when every finding is something other than a missing record", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SENT_AT_MS + 6 * 60_000);
    const relay = JSON.parse(relayHitsText);
    // Both paths return the relay records, so the route path's records carry
    // the wrong run id: run-id findings, and nothing missing.
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = (args ?? []).map(String);
      return JSON.stringify({
        data: argv[1] === "traces" ? relay.spans : relay.logs,
      });
    });
    const outDir = writeRunFile();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const passed = await collect(outDir);
    const lines = log.mock.calls.map((args) => String(args[0]));
    const findingKinds = new Set(
      lines
        .filter((line) => line.startsWith("FINDING "))
        .map((line) => JSON.parse(line.slice("FINDING ".length)).kind)
    );

    expect(passed).toBe(false);
    expect(lines).toContain("span search: live");
    expect(lines.at(-1)).toBe("NOT PARITY");
    expect(findingKinds.has(ParityFindingKind.RunIdMismatch)).toBe(true);
    expect(findingKinds.has(ParityFindingKind.Missing)).toBe(false);
    expect(lines.some((line) => line.startsWith("records may still be"))).toBe(
      false
    );
  });
});

function writeRunFile(): string {
  const outDir = mkdtempSync(join(tmpdir(), "otlp-egress-parity-iss12394-"));
  outDirs.push(outDir);
  writeFileSync(
    join(outDir, "run.json"),
    JSON.stringify({
      sentAt: SENT_AT,
      finishedAt: SENT_AT,
      paths: {
        relay: { installationId: RELAY_RUN_ID },
        route: { installationId: ROUTE_RUN_ID },
      },
    })
  );
  return outDir;
}
