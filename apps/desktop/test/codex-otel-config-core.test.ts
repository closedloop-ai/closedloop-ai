import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  buildManagedOtelBlock,
  type CodexOtelFileSystem,
  installCodexOtelConfig,
  uninstallCodexOtelConfig,
} from "../src/main/codex-otel-config-core.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  type OtlpReceiverState,
} from "../src/main/otlp-receiver-state.js";
import { AgentMonitorHooksWarningCode } from "../src/shared/contracts.js";

let tempRoot = "";

const MANAGED_MARKER_RE = /closedloop_agent_monitor_managed = true/;
const OTEL_HEADER_RE = /^\[otel\]/;
const LOGS_ENDPOINT_RE = /endpoint = "http:\/\/127\.0\.0\.1:54321\/v1\/logs"/;
const TRACES_ENDPOINT_RE =
  /endpoint = "http:\/\/127\.0\.0\.1:54321\/v1\/traces"/;
const CURRENT_LOGS_ENDPOINT_RE = /127\.0\.0\.1:54321\/v1\/logs/;
const STALE_LOGS_ENDPOINT_RE = /127\.0\.0\.1:12345\/v1\/logs/;
const LEGACY_LOCALHOST_LOGS_ENDPOINT_RE = /localhost:12345\/v1\/logs/;
const LEGACY_LOCALHOST_TRACES_ENDPOINT_RE = /localhost:12345\/v1\/traces/;
const PROFILE_SECTION_RE = /\[profiles\.default\]/;
const RESTORED_OTEL_RE = /\[otel\]\nexporter = "none"/;

const receiver: OtlpReceiverState = {
  available: true,
  host: DEFAULT_OTLP_RECEIVER_HOST,
  port: 54_321,
};

const staleReceiver: OtlpReceiverState = {
  available: true,
  host: DEFAULT_OTLP_RECEIVER_HOST,
  port: 12_345,
};

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "codex-otel-"));
});

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("install fails closed when receiver state is unavailable", () => {
  const file = configPath();
  const result = installCodexOtelConfig({
    file,
    receiverState: { ...receiver, available: false },
  });

  assert.equal(result.status, "warning");
  assert.equal(
    result.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelReceiverUnavailable
  );
  assert.equal(existsSync(file), false);
  assert.equal(backupNames(file).length, 0);
});

test("install writes the documented Codex OTLP HTTP endpoints from receiver state", () => {
  const file = configPath();
  const result = installCodexOtelConfig({ file, receiverState: receiver });

  assert.equal(result.status, "written");
  const text = readFileSync(file, "utf8");
  assert.match(text, OTEL_HEADER_RE);
  assert.match(text, MANAGED_MARKER_RE);
  assert.match(text, LOGS_ENDPOINT_RE);
  assert.match(text, TRACES_ENDPOINT_RE);
});

test("install backs up a pre-existing config once with ownership metadata", () => {
  const file = configPath();
  writeFileSync(file, '# user config\n[profiles.default]\nmodel = "gpt-5.5"\n');

  installCodexOtelConfig({
    file,
    receiverState: receiver,
    now: () => new Date("2026-06-17T22:00:00.000Z"),
  });
  installCodexOtelConfig({
    file,
    receiverState: receiver,
    now: () => new Date("2026-06-17T22:01:00.000Z"),
  });

  const backups = backupNames(file);
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(tempRoot, backups[0]), "utf8"),
    '# user config\n[profiles.default]\nmodel = "gpt-5.5"\n'
  );
  const metadata = JSON.parse(
    readFileSync(join(tempRoot, `${backups[0]}.closedloop-meta.json`), "utf8")
  ) as { owner: string; kind: string; source: string; backup: string };
  assert.equal(metadata.owner, "closedloop-agent-monitor");
  assert.equal(metadata.kind, "codex-otel-config-backup");
  assert.equal(metadata.source, "config.toml");
  assert.equal(metadata.backup, backups[0]);
});

test("reinstall of an exact managed block is a no-op for content and mtime", () => {
  const file = configPath();
  installCodexOtelConfig({ file, receiverState: receiver });
  const beforeText = readFileSync(file, "utf8");
  const beforeMtime = statSync(file).mtimeMs;

  const result = installCodexOtelConfig({ file, receiverState: receiver });

  assert.equal(result.status, "noop");
  assert.equal(readFileSync(file, "utf8"), beforeText);
  assert.equal(statSync(file).mtimeMs, beforeMtime);
});

test("install repairs a marker-owned stale port and preserves unrelated TOML", () => {
  const file = configPath();
  const unrelated = '# keep\n[profiles.default]\nmodel = "gpt-5.5"\n\n';
  writeFileSync(file, `${unrelated}${buildManagedOtelBlock(staleReceiver)}`);

  const result = installCodexOtelConfig({ file, receiverState: receiver });

  assert.equal(result.status, "repaired");
  const text = readFileSync(file, "utf8");
  assert.equal(text.startsWith(unrelated), true);
  assert.match(text, CURRENT_LOGS_ENDPOINT_RE);
  assert.doesNotMatch(text, STALE_LOGS_ENDPOINT_RE);
});

test("install repairs marker-owned legacy localhost endpoints to loopback", () => {
  const file = configPath();
  const unrelated = '# keep\n[profiles.default]\nmodel = "gpt-5.5"\n\n';
  writeFileSync(
    file,
    `${unrelated}${legacyLocalhostManagedBlock(staleReceiver)}`
  );

  const result = installCodexOtelConfig({ file, receiverState: receiver });

  assert.equal(result.status, "repaired");
  const text = readFileSync(file, "utf8");
  assert.equal(text.startsWith(unrelated), true);
  assert.match(text, CURRENT_LOGS_ENDPOINT_RE);
  assert.doesNotMatch(text, LEGACY_LOCALHOST_LOGS_ENDPOINT_RE);
  assert.doesNotMatch(text, LEGACY_LOCALHOST_TRACES_ENDPOINT_RE);
});

test("install preserves unmanaged otel blocks, including canonical-looking blocks", () => {
  const file = configPath();
  writeFileSync(
    file,
    buildManagedOtelBlock(receiver).replace(
      "closedloop_agent_monitor_managed = true\n",
      ""
    )
  );
  const before = readFileSync(file, "utf8");

  const result = installCodexOtelConfig({ file, receiverState: receiver });

  assert.equal(result.status, "warning");
  assert.equal(
    result.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelConflict
  );
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(backupNames(file).length, 0);
});

test("marker-like comments and strings remain unmanaged otel blocks", () => {
  const file = configPath();
  const markerLikeBlocks = [
    '[otel]\n# closedloop_agent_monitor_managed = true\nexporter = "none"\n',
    '[otel]\nmarker = "closedloop_agent_monitor_managed = true"\n',
    "[otel]\nnot_closedloop_agent_monitor_managed = true\n",
  ];

  for (const block of markerLikeBlocks) {
    writeFileSync(file, block);

    const installResult = installCodexOtelConfig({
      file,
      receiverState: receiver,
    });
    const uninstallResult = uninstallCodexOtelConfig({ file });

    assert.equal(
      installResult.warnings?.[0]?.code,
      AgentMonitorHooksWarningCode.CodexOtelConflict
    );
    assert.equal(
      uninstallResult.warnings?.[0]?.code,
      AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped
    );
    assert.equal(readFileSync(file, "utf8"), block);
  }
});

test("otel array-of-table forms are conflicts instead of append targets", () => {
  const file = configPath();
  const blocks = [
    '[[otel]]\nexporter = "none"\n',
    '[[otel.exporter]]\nname = "custom"\n',
  ];

  for (const block of blocks) {
    writeFileSync(file, block);

    const installResult = installCodexOtelConfig({
      file,
      receiverState: receiver,
    });
    const uninstallResult = uninstallCodexOtelConfig({ file });

    assert.equal(
      installResult.warnings?.[0]?.code,
      AgentMonitorHooksWarningCode.CodexOtelConflict
    );
    assert.equal(
      uninstallResult.warnings?.[0]?.code,
      AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped
    );
    assert.equal(readFileSync(file, "utf8"), block);
  }
});

test("uninstall removes only marker-owned blocks and ignores filename-only backups", () => {
  const file = configPath();
  writeFileSync(
    file,
    `# keep\n${buildManagedOtelBlock(receiver)}[profiles.default]\nmodel = "gpt-5.5"\n`
  );
  writeFileSync(
    join(tempRoot, "config.toml.closedloop-bak.2026-06-17T22-00-00-000Z"),
    '[otel]\nexporter = "none"\n'
  );

  const result = uninstallCodexOtelConfig({ file });

  assert.equal(result.status, "removed");
  const text = readFileSync(file, "utf8");
  assert.equal(text.includes("closedloop_agent_monitor_managed"), false);
  assert.equal(text.includes('exporter = "none"'), false);
  assert.match(text, PROFILE_SECTION_RE);
});

test("repairing an old managed block does not create a restorable managed backup", () => {
  const file = configPath();

  installCodexOtelConfig({ file, receiverState: staleReceiver });
  installCodexOtelConfig({ file, receiverState: receiver });
  const result = uninstallCodexOtelConfig({ file });

  assert.equal(result.status, "removed");
  assert.equal(readFileSync(file, "utf8").includes("[otel]"), false);
  assert.equal(backupNames(file).length, 0);
});

test("uninstall removes marker-owned legacy localhost blocks", () => {
  const file = configPath();
  writeFileSync(
    file,
    `# keep\n${legacyLocalhostManagedBlock(staleReceiver)}[profiles.default]\nmodel = "gpt-5.5"\n`
  );

  const result = uninstallCodexOtelConfig({ file });

  assert.equal(result.status, "removed");
  const text = readFileSync(file, "utf8");
  assert.equal(text.includes("closedloop_agent_monitor_managed"), false);
  assert.doesNotMatch(text, LEGACY_LOCALHOST_LOGS_ENDPOINT_RE);
  assert.doesNotMatch(text, LEGACY_LOCALHOST_TRACES_ENDPOINT_RE);
  assert.match(text, PROFILE_SECTION_RE);
});

test("uninstall restores a prior otel block only from a metadata-owned backup", () => {
  const file = configPath();
  const backupFile = join(
    tempRoot,
    "config.toml.closedloop-bak.2026-06-17T22-00-00-000Z"
  );
  writeFileSync(
    file,
    `# current\n${buildManagedOtelBlock(receiver)}[profiles.default]\nmodel = "gpt-5.5"\n`
  );
  writeFileSync(
    backupFile,
    '[otel]\nexporter = "none"\n\n[other]\nkeep = true\n'
  );
  writeFileSync(
    `${backupFile}.closedloop-meta.json`,
    `${JSON.stringify({
      version: 1,
      owner: "closedloop-agent-monitor",
      kind: "codex-otel-config-backup",
      source: basename(file),
      backup: basename(backupFile),
      createdAt: "2026-06-17T22:00:00.000Z",
    })}\n`
  );

  const result = uninstallCodexOtelConfig({ file });

  assert.equal(result.status, "restored");
  const text = readFileSync(file, "utf8");
  assert.match(text, RESTORED_OTEL_RE);
  assert.match(text, PROFILE_SECTION_RE);
  assert.equal(text.includes("[other]"), false);
});

test("uninstall preserves unmanaged otel blocks with a skipped warning", () => {
  const file = configPath();
  writeFileSync(file, '[otel]\nexporter = "none"\n');

  const result = uninstallCodexOtelConfig({ file });

  assert.equal(result.status, "warning");
  assert.equal(
    result.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped
  );
  assert.equal(readFileSync(file, "utf8"), '[otel]\nexporter = "none"\n');
});

test("install and uninstall map filesystem failures to structured warnings", () => {
  const file = configPath();
  const writeFailingFs = makeFs({
    writeFileSync: ((target: Parameters<typeof writeFileSync>[0]) => {
      if (String(target).endsWith(".tmp")) {
        throw new Error("write blocked");
      }
    }) as typeof writeFileSync,
  });

  const installResult = installCodexOtelConfig({
    file,
    receiverState: receiver,
    fs: writeFailingFs,
  });

  assert.equal(
    installResult.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelWriteFailed
  );
  assert.equal(existsSync(file), false);

  writeFileSync(file, buildManagedOtelBlock(receiver));
  const uninstallResult = uninstallCodexOtelConfig({
    file,
    fs: writeFailingFs,
  });
  assert.equal(
    uninstallResult.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelUninstallFailed
  );
  assert.equal(readFileSync(file, "utf8"), buildManagedOtelBlock(receiver));
});

function backupNames(file: string): string[] {
  const prefix = `${basename(file)}.closedloop-bak.`;
  return readdirSync(tempRoot)
    .filter(
      (name) =>
        name.startsWith(prefix) && !name.endsWith(".closedloop-meta.json")
    )
    .sort();
}

function configPath(): string {
  return join(tempRoot, "config.toml");
}

function legacyLocalhostManagedBlock(receiverState: OtlpReceiverState): string {
  return buildManagedOtelBlock(receiverState).replaceAll(
    DEFAULT_OTLP_RECEIVER_HOST,
    "localhost"
  );
}

function makeFs(overrides: Partial<CodexOtelFileSystem>): CodexOtelFileSystem {
  return {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
    ...overrides,
  };
}
