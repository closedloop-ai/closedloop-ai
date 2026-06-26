import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  type AgentMonitorHooksWarning,
  AgentMonitorHooksWarningCode,
} from "../shared/contracts.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  type OtlpReceiverState,
} from "./otlp-receiver-state.js";

const OWNERSHIP_KEY = "closedloop_agent_monitor_managed";
const OWNERSHIP_MARKER = `${OWNERSHIP_KEY} = true`;
const BACKUP_OWNER = "closedloop-agent-monitor";
const BACKUP_KIND = "codex-otel-config-backup";
const BACKUP_METADATA_SUFFIX = ".closedloop-meta.json";
const OTEL_LOG_PROTOCOL = "binary";

const TOML_TABLE_HEADER_RE = /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?(?:\r?\n)?$/;
const TOML_ARRAY_TABLE_HEADER_RE =
  /^\s*\[\[([^\]\r\n]+)\]\]\s*(?:#.*)?(?:\r?\n)?$/;
const OWNERSHIP_ASSIGNMENT_RE =
  /^\s*closedloop_agent_monitor_managed\s*=\s*true\s*(?:#.*)?$/;
const BACKUP_STAMP_RE = /[:.]/g;
const VALID_RECEIVER_PORT_MIN = 1;
const VALID_RECEIVER_PORT_MAX = 65_535;
const BackupMetadataSchema = z.object({
  version: z.literal(1),
  owner: z.literal(BACKUP_OWNER),
  kind: z.literal(BACKUP_KIND),
  source: z.string(),
  backup: z.string(),
});

export type CodexOtelMutationStatus =
  | "noop"
  | "written"
  | "repaired"
  | "removed"
  | "restored"
  | "warning";

export type CodexOtelMutationResult = {
  status: CodexOtelMutationStatus;
  warnings?: AgentMonitorHooksWarning[];
};

export type CodexOtelFileSystem = {
  copyFileSync: typeof copyFileSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  renameSync: typeof renameSync;
  writeFileSync: typeof writeFileSync;
};

export type CodexOtelConfigInput = {
  file: string;
  receiverState?: OtlpReceiverState | null;
  fs?: CodexOtelFileSystem;
  now?: () => Date;
};

export function installCodexOtelConfig(
  input: CodexOtelConfigInput
): CodexOtelMutationResult {
  const receiver = normalizeReceiver(input.receiverState);
  if (!receiver) {
    return warning(
      AgentMonitorHooksWarningCode.CodexOtelReceiverUnavailable,
      input.file,
      "Codex OTel config was not changed because the local OTLP receiver is unavailable."
    );
  }

  const fsImpl = input.fs ?? realFs;
  try {
    const before = fsImpl.existsSync(input.file)
      ? fsImpl.readFileSync(input.file, "utf8")
      : "";
    const section = findOtelSection(before);
    if (section && !isManagedSection(section.text)) {
      return warning(
        AgentMonitorHooksWarningCode.CodexOtelConflict,
        input.file,
        "Codex OTel config was preserved because an unmanaged [otel] table already exists."
      );
    }

    const managedBlock = buildManagedOtelBlock(receiver);
    const next = section
      ? replaceRange(before, section.start, section.end, managedBlock)
      : appendSection(before, managedBlock);
    if (next === before) {
      return { status: "noop" };
    }

    if (!section) {
      createBackupIfNeeded(
        input.file,
        before,
        fsImpl,
        input.now ?? (() => new Date())
      );
    }
    writeTomlFile(input.file, next, fsImpl);
    return { status: section ? "repaired" : "written" };
  } catch (error) {
    return warning(
      AgentMonitorHooksWarningCode.CodexOtelWriteFailed,
      input.file,
      `Codex OTel config could not be written: ${errorMessage(error)}`
    );
  }
}

export function uninstallCodexOtelConfig(
  input: Omit<CodexOtelConfigInput, "receiverState">
): CodexOtelMutationResult {
  const fsImpl = input.fs ?? realFs;
  try {
    if (!fsImpl.existsSync(input.file)) {
      return { status: "noop" };
    }
    const before = fsImpl.readFileSync(input.file, "utf8");
    const section = findOtelSection(before);
    if (!section) {
      return { status: "noop" };
    }
    if (!isManagedSection(section.text)) {
      return warning(
        AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped,
        input.file,
        "Codex OTel config was preserved because its [otel] table is not Closedloop-managed."
      );
    }

    const restoreSection = findRestorableOtelSection(input.file, fsImpl);
    const replacement = restoreSection ?? "";
    const next = replaceRange(before, section.start, section.end, replacement);
    if (next === before) {
      return { status: "noop" };
    }
    writeTomlFile(input.file, next, fsImpl);
    return { status: restoreSection ? "restored" : "removed" };
  } catch (error) {
    return warning(
      AgentMonitorHooksWarningCode.CodexOtelUninstallFailed,
      input.file,
      `Codex OTel config could not be removed: ${errorMessage(error)}`
    );
  }
}

export function buildManagedOtelBlock(receiver: ValidReceiverState): string {
  const logsEndpoint = `http://${receiver.host}:${receiver.port}/v1/logs`;
  const tracesEndpoint = `http://${receiver.host}:${receiver.port}/v1/traces`;
  return [
    "[otel]",
    "# Closedloop Agent Monitor managed block. Ownership is required for repair or uninstall.",
    OWNERSHIP_MARKER,
    "log_user_prompt = false",
    `exporter = { otlp-http = { endpoint = ${JSON.stringify(logsEndpoint)}, protocol = ${JSON.stringify(OTEL_LOG_PROTOCOL)} } }`,
    `trace_exporter = { otlp-http = { endpoint = ${JSON.stringify(tracesEndpoint)}, protocol = ${JSON.stringify(OTEL_LOG_PROTOCOL)} } }`,
    "",
  ].join("\n");
}

function appendSection(text: string, section: string): string {
  if (!text) {
    return section;
  }
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${section}`;
}

function createBackupIfNeeded(
  file: string,
  currentText: string,
  fsImpl: CodexOtelFileSystem,
  now: () => Date
): void {
  if (!(currentText || fsImpl.existsSync(file))) {
    return;
  }
  if (findOwnedBackup(file, fsImpl)) {
    return;
  }
  const backupFile = backupPath(file, now());
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.copyFileSync(file, backupFile);
  fsImpl.writeFileSync(
    metadataPath(backupFile),
    `${JSON.stringify(
      {
        version: 1,
        owner: BACKUP_OWNER,
        kind: BACKUP_KIND,
        source: path.basename(file),
        backup: path.basename(backupFile),
        createdAt: now().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function findOwnedBackup(
  file: string,
  fsImpl: CodexOtelFileSystem
): string | null {
  const dir = path.dirname(file);
  if (!fsImpl.existsSync(dir)) {
    return null;
  }
  const prefix = `${path.basename(file)}.closedloop-bak.`;
  const backupName = fsImpl
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .find((name) => backupMetadataIsValid(file, path.join(dir, name), fsImpl));
  return backupName ? path.join(dir, backupName) : null;
}

function findRestorableOtelSection(
  file: string,
  fsImpl: CodexOtelFileSystem
): string | null {
  const backupFile = findOwnedBackup(file, fsImpl);
  if (!backupFile) {
    return null;
  }
  const backupText = fsImpl.readFileSync(backupFile, "utf8");
  return findOtelSection(backupText)?.text ?? null;
}

function backupMetadataIsValid(
  file: string,
  backupFile: string,
  fsImpl: CodexOtelFileSystem
): boolean {
  const sidecar = metadataPath(backupFile);
  if (!fsImpl.existsSync(sidecar)) {
    return false;
  }
  try {
    const parsed = BackupMetadataSchema.safeParse(
      JSON.parse(fsImpl.readFileSync(sidecar, "utf8"))
    );
    if (!parsed.success) {
      return false;
    }
    return (
      parsed.data.source === path.basename(file) &&
      parsed.data.backup === path.basename(backupFile)
    );
  } catch {
    return false;
  }
}

function backupPath(file: string, createdAt: Date): string {
  const stamp = createdAt.toISOString().replaceAll(BACKUP_STAMP_RE, "-");
  return path.join(
    path.dirname(file),
    `${path.basename(file)}.closedloop-bak.${stamp}`
  );
}

function metadataPath(backupFile: string): string {
  return `${backupFile}${BACKUP_METADATA_SUFFIX}`;
}

function findOtelSection(text: string): {
  start: number;
  end: number;
  text: string;
} | null {
  const lines = linesWithOffsets(text);
  const startIndex = lines.findIndex((line) => isOtelHeader(line.text));
  if (startIndex < 0) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const header = headerName(lines[index].text);
    if (header && !isOtelHeaderName(header)) {
      endIndex = index;
      break;
    }
  }

  const start = lines[startIndex].start;
  const end = endIndex < lines.length ? lines[endIndex].start : text.length;
  return {
    start,
    end,
    text: text.slice(start, end),
  };
}

function isManagedSection(section: string): boolean {
  if (!hasExactOtelTableHeader(section)) {
    return false;
  }
  return linesWithOffsets(section).some((line) =>
    OWNERSHIP_ASSIGNMENT_RE.test(line.text)
  );
}

function isOtelHeader(line: string): boolean {
  const header = headerName(line);
  return header ? isOtelHeaderName(header) : false;
}

function isOtelHeaderName(header: string): boolean {
  return header === "otel" || header.startsWith("otel.");
}

function headerName(line: string): string | null {
  const match =
    line.match(TOML_ARRAY_TABLE_HEADER_RE) ?? line.match(TOML_TABLE_HEADER_RE);
  return match?.[1]?.trim() ?? null;
}

function hasExactOtelTableHeader(section: string): boolean {
  const firstLine = linesWithOffsets(section)[0]?.text;
  const match = firstLine?.match(TOML_TABLE_HEADER_RE);
  return match?.[1]?.trim() === "otel";
}

function linesWithOffsets(
  text: string
): Array<{ start: number; text: string }> {
  const lines: Array<{ start: number; text: string }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ start, text: text.slice(start, end) });
    start = end;
  }
  return lines;
}

function normalizeReceiver(
  receiverState: OtlpReceiverState | null | undefined
): ValidReceiverState | null {
  if (
    receiverState?.available !== true ||
    receiverState.host !== DEFAULT_OTLP_RECEIVER_HOST ||
    !Number.isInteger(receiverState.port) ||
    receiverState.port < VALID_RECEIVER_PORT_MIN ||
    receiverState.port > VALID_RECEIVER_PORT_MAX
  ) {
    return null;
  }
  return { host: receiverState.host, port: receiverState.port };
}

function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string
): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function writeTomlFile(
  file: string,
  text: string,
  fsImpl: CodexOtelFileSystem
): void {
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  fsImpl.writeFileSync(tempFile, text, "utf8");
  fsImpl.renameSync(tempFile, file);
}

function warning(
  code: AgentMonitorHooksWarningCode,
  file: string,
  message: string
): CodexOtelMutationResult {
  return {
    status: "warning",
    warnings: [
      {
        code,
        path: file,
        message,
      },
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ValidReceiverState = {
  host: typeof DEFAULT_OTLP_RECEIVER_HOST;
  port: number;
};

const realFs: CodexOtelFileSystem = {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
};
