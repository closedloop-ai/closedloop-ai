import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedOtelBlock,
  type CodexOtelFileSystem,
  installCodexOtelConfig,
  uninstallCodexOtelConfig,
} from "../src/main/telemetry/codex-otel-config-core.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  type OtlpReceiverState,
} from "../src/main/telemetry/otlp-receiver-state.js";
import { AgentMonitorHooksWarningCode } from "../src/shared/contracts.js";

const receiver: OtlpReceiverState = {
  available: true,
  host: DEFAULT_OTLP_RECEIVER_HOST,
  port: 54_321,
};
const managedBlock = buildManagedOtelBlock({
  host: DEFAULT_OTLP_RECEIVER_HOST,
  port: 54_321,
});
const USER_CONFIG = 'model = "gpt-5.5"';

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-otel-cov-iss11283-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function configFile(): string {
  return join(root, "config.toml");
}

function backups(): string[] {
  return readdirSync(root).filter(
    (name) =>
      name.startsWith("config.toml.closedloop-bak.") &&
      !name.endsWith(".closedloop-meta.json")
  );
}

function writeBackup(
  name: string,
  text: string,
  metadata: Record<string, unknown>
): void {
  writeFileSync(join(root, name), text);
  writeFileSync(
    join(root, `${name}.closedloop-meta.json`),
    JSON.stringify(metadata)
  );
}

function ownedMetadata(name: string): Record<string, unknown> {
  return {
    version: 1,
    owner: "closedloop-agent-monitor",
    kind: "codex-otel-config-backup",
    source: "config.toml",
    backup: name,
  };
}

describe("installCodexOtelConfig edges", () => {
  it("stamps the backup with the wall clock when no clock is injected", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T12:34:56.789Z"));
    const file = configFile();
    writeFileSync(file, `${USER_CONFIG}\n`);
    expect(installCodexOtelConfig({ file, receiverState: receiver })).toEqual({
      status: "written",
    });
    expect(backups()).toEqual([
      "config.toml.closedloop-bak.2026-09-01T12-34-56-789Z",
    ]);
  });

  it("separates the appended block with a blank line when the file lacks a trailing newline", () => {
    const file = configFile();
    writeFileSync(file, USER_CONFIG);
    installCodexOtelConfig({
      file,
      receiverState: receiver,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(readFileSync(file, "utf8")).toBe(
      `${USER_CONFIG}\n\n${managedBlock}`
    );
  });

  it("reuses an existing owned backup instead of taking a second one", () => {
    const file = configFile();
    writeFileSync(file, `${USER_CONFIG}\n`);
    const now = () => new Date("2026-09-01T00:00:00.000Z");
    installCodexOtelConfig({ file, receiverState: receiver, now });
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "removed" });
    expect(readFileSync(file, "utf8")).toBe(`${USER_CONFIG}\n\n`);
    expect(
      installCodexOtelConfig({
        file,
        receiverState: receiver,
        now: () => new Date("2026-09-02T00:00:00.000Z"),
      })
    ).toEqual({ status: "written" });
    expect(backups()).toEqual([
      "config.toml.closedloop-bak.2026-09-01T00-00-00-000Z",
    ]);
  });

  it("writes exactly the managed block into a config that did not exist", () => {
    const file = configFile();
    expect(
      installCodexOtelConfig({
        file,
        receiverState: receiver,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
      })
    ).toEqual({ status: "written" });
    expect(readFileSync(file, "utf8")).toBe(managedBlock);
    expect(backups()).toEqual([]);
  });

  it("backs up an existing empty config before appending", () => {
    const file = configFile();
    writeFileSync(file, "");
    installCodexOtelConfig({
      file,
      receiverState: receiver,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(backups()).toEqual([
      "config.toml.closedloop-bak.2026-09-01T00-00-00-000Z",
    ]);
  });

  it("repairs a stale managed block in place without taking a backup", () => {
    const file = configFile();
    const stale = buildManagedOtelBlock({
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 12_345,
    });
    writeFileSync(file, `${USER_CONFIG}\n${stale}`);
    expect(
      installCodexOtelConfig({
        file,
        receiverState: receiver,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
      })
    ).toEqual({ status: "repaired" });
    expect(readFileSync(file, "utf8")).toBe(`${USER_CONFIG}\n${managedBlock}`);
    expect(backups()).toEqual([]);
  });

  it("reports a non-Error write failure by its string value", () => {
    const file = configFile();
    const failingFs: CodexOtelFileSystem = {
      copyFileSync,
      existsSync,
      mkdirSync,
      readFileSync,
      readdirSync,
      renameSync,
      writeFileSync: () => {
        throwValue("disk full");
      },
    };
    expect(
      installCodexOtelConfig({ file, receiverState: receiver, fs: failingFs })
    ).toEqual({
      status: "warning",
      warnings: [
        {
          code: AgentMonitorHooksWarningCode.CodexOtelWriteFailed,
          path: file,
          message: "Codex OTel config could not be written: disk full",
        },
      ],
    });
    expect(existsSync(file)).toBe(false);
  });
});

describe("uninstallCodexOtelConfig edges", () => {
  it("is a no-op when the config file does not exist", () => {
    const file = configFile();
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "noop" });
    expect(existsSync(file)).toBe(false);
  });

  it("is a no-op when the config has no otel table", () => {
    const file = configFile();
    writeFileSync(file, `${USER_CONFIG}\n`);
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "noop" });
    expect(readFileSync(file, "utf8")).toBe(`${USER_CONFIG}\n`);
  });

  it("skips an unmanaged otel table with a warning", () => {
    const file = configFile();
    const text = '[otel]\nexporter = "none"\n';
    writeFileSync(file, text);
    expect(uninstallCodexOtelConfig({ file })).toEqual({
      status: "warning",
      warnings: [
        {
          code: AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped,
          path: file,
          message:
            "Codex OTel config was preserved because its [otel] table is not Closedloop-managed.",
        },
      ],
    });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("ignores a backup that has no ownership sidecar", () => {
    const file = configFile();
    writeFileSync(file, `${USER_CONFIG}\n\n${managedBlock}`);
    writeFileSync(
      join(root, "config.toml.closedloop-bak.2026-09-01T00-00-00-000Z"),
      '[otel]\nexporter = "none"\n'
    );
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "removed" });
  });

  it("is a no-op when the owned backup holds the same managed block", () => {
    const file = configFile();
    const text = `${USER_CONFIG}\n\n${managedBlock}`;
    writeFileSync(file, text);
    const name = "config.toml.closedloop-bak.2026-09-01T00-00-00-000Z";
    writeBackup(name, managedBlock, ownedMetadata(name));
    // pins current behavior; looks odd because uninstall then leaves the managed block in place for good
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "noop" });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("removes the block instead of restoring from a backup whose metadata fails the schema", () => {
    const file = configFile();
    writeFileSync(file, `${USER_CONFIG}\n\n${managedBlock}`);
    const name = "config.toml.closedloop-bak.2026-09-01T00-00-00-000Z";
    writeBackup(name, '[otel]\nexporter = "none"\n', {
      ...ownedMetadata(name),
      version: 2,
    });
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "removed" });
    expect(readFileSync(file, "utf8")).toBe(`${USER_CONFIG}\n\n`);
  });

  it("removes a managed block that ends the file without a trailing newline", () => {
    const file = configFile();
    const unterminated = managedBlock.trimEnd();
    writeFileSync(file, `${USER_CONFIG}\n${unterminated}`);
    expect(uninstallCodexOtelConfig({ file })).toEqual({ status: "removed" });
    expect(readFileSync(file, "utf8")).toBe(`${USER_CONFIG}\n`);
  });
});

function throwValue(value: unknown): never {
  throw value;
}
