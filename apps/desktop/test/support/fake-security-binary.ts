/**
 * ISS-12120: a fake macOS `security` binary for the Keychain probe.
 *
 * The probe addresses `/usr/bin/security` by absolute path on purpose
 * (`anthropic-keychain.ts`), so a suite reaches the fake by mocking
 * `node:child_process` with {@link redirectSecurityBinary}. The redirect wraps
 * `execFileSync`, `execFile` and `spawn` alike, so one suite runs unchanged
 * whichever child-process call the probe makes. Every other call passes
 * through untouched, and a probe that runs while no fake is installed reaches
 * a stub that answers "absent", never the real Keychain.
 *
 * The fake writes a `started` marker, records its argv, and in `handshake`
 * mode writes an `ack` file only if it sees the test's `release` file while
 * it is still alive. A blocked event loop cannot run the timer that writes
 * `release`, so an ack proves the caller yielded while the child ran.
 *
 * This module imports nothing from `src/`: it is loaded from inside the
 * `node:child_process` mock factory, before any production module.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Explicit timeout for a suite whose cases spawn the fake and wait on it, so a
 * hang fails by name instead of at the runner's default.
 */
export const FAKE_SECURITY_SUITE_TIMEOUT_MS = 10_000;

const tempDirs: string[] = [];

function makeFakeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export const SECURITY_BINARY = "/usr/bin/security";

/** How the fake `security` answers. */
export const FakeSecurityMode = {
  /** Exit 0: the item exists. */
  Present: "present",
  /** Exit 44, what `security` returns for a missing item. */
  Absent: "absent",
  /** Outlive the probe's 800 ms timeout. */
  Hang: "hang",
  /** Poll ten times for `release` (well inside the 800 ms timeout), ack it if seen, then exit 0. */
  Handshake: "handshake",
} as const;
export type FakeSecurityMode =
  (typeof FakeSecurityMode)[keyof typeof FakeSecurityMode];

type ChildProcessModule = typeof import("node:child_process");

let fakeSecurityPath: string | null = null;
let absentStubPath: string | null = null;

function absentStub(): string {
  if (absentStubPath === null) {
    const dir = makeFakeDir("keychain-absent-stub-");
    absentStubPath = join(dir, "security");
    writeFileSync(absentStubPath, "#!/bin/sh\nexit 44\n");
    chmodSync(absentStubPath, 0o755);
  }
  return absentStubPath;
}

function redirect(file: unknown): unknown {
  return file === SECURITY_BINARY ? (fakeSecurityPath ?? absentStub()) : file;
}

/** The `vi.mock("node:child_process", …)` factory body. */
export function redirectSecurityBinary(
  original: ChildProcessModule
): ChildProcessModule {
  const wrap = <F extends (...args: never[]) => unknown>(fn: F): F =>
    ((file: unknown, ...rest: unknown[]) =>
      (fn as unknown as (...args: unknown[]) => unknown)(
        redirect(file),
        ...rest
      )) as unknown as F;
  return {
    ...original,
    execFileSync: wrap(original.execFileSync),
    execFile: wrap(original.execFile),
    spawn: wrap(original.spawn),
  };
}

export type FakeSecurity = {
  /** Whether the fake ran at all. */
  started: () => boolean;
  /** Whether the fake saw `release` while it was still running. */
  acked: () => boolean;
  /** The argv the fake was invoked with, one argument per line. */
  args: () => string[];
  /** Write the release file the handshake fake waits for. */
  release: () => void;
  /** Whether the `present` fake reached its final line, just before `exit 0`. */
  answered: () => boolean;
};

/** Install a fake `security` for the next probe; {@link resetFakeSecurity} removes it. */
export function installFakeSecurity(mode: FakeSecurityMode): FakeSecurity {
  const dir = makeFakeDir("keychain-fake-security-");
  const path = join(dir, "security");
  const started = join(dir, "started");
  const ack = join(dir, "ack");
  const argsFile = join(dir, "args");
  const releaseFile = join(dir, "release");
  const answered = join(dir, "answered");
  const body: Record<FakeSecurityMode, string> = {
    present: `: > '${answered}'\nexit 0`,
    absent: "exit 44",
    hang: "exec sleep 5",
    handshake: [
      "i=0",
      "while [ $i -lt 10 ]; do",
      `  if [ -f '${releaseFile}' ]; then : > '${ack}'; exit 0; fi`,
      "  sleep 0.02",
      "  i=$((i + 1))",
      "done",
      "exit 0",
    ].join("\n"),
  };
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `: > '${started}'`,
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argsFile}'; done`,
      body[mode],
      "",
    ].join("\n")
  );
  chmodSync(path, 0o755);
  fakeSecurityPath = path;
  return {
    started: () => existsSync(started),
    acked: () => existsSync(ack),
    args: () =>
      existsSync(argsFile)
        ? readFileSync(argsFile, "utf8").split("\n").filter(Boolean)
        : [],
    release: () => writeFileSync(releaseFile, ""),
    answered: () => existsSync(answered),
  };
}

/** Remove the installed fake and every fake directory this module created. */
export function resetFakeSecurity(): void {
  fakeSecurityPath = null;
  absentStubPath = null;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
