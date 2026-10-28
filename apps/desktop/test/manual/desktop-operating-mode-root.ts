import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_HOME_ENV_KEYS,
  isolatedHarnessHomes,
} from "../helpers/isolated-harness-homes.js";

const SENTINEL_FILE = ".closedloop-desktop-operating-mode";

export type DesktopOperatingModeRun = {
  runId: string;
  root: string;
  userDataDir: string;
  evidenceDir: string;
  profileDir: string;
  homes: Record<string, string>;
  sentinelPath: string;
};

/** Creates one sentinel-owned disposable profile and every collector home. */
export function createDesktopOperatingModeRun(): DesktopOperatingModeRun {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-10574-desktop-operating-mode-")
  );
  const canonicalRoot = fs.realpathSync(root);
  const userDataDir = path.join(canonicalRoot, "user-data");
  const evidenceDir = path.join(canonicalRoot, "evidence");
  const profileDir = path.join(canonicalRoot, "profile");
  const homesRoot = path.join(canonicalRoot, "harness-homes");
  for (const dir of [userDataDir, evidenceDir, profileDir, homesRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const homes = isolatedHarnessHomes(homesRoot);
  validateIsolatedHarnessHomes(canonicalRoot, homes);
  const sentinelPath = path.join(canonicalRoot, SENTINEL_FILE);
  const runId = randomUUID();
  fs.writeFileSync(
    sentinelPath,
    JSON.stringify({ root: canonicalRoot, runId }),
    { encoding: "utf8", mode: 0o600 }
  );
  return {
    runId,
    root: canonicalRoot,
    userDataDir,
    evidenceDir,
    profileDir,
    homes,
    sentinelPath,
  };
}

/** Refuses any cleanup target not proven to be this harness's exact temp root. */
export function cleanupDesktopOperatingModeRun(
  target: string,
  expectedRunId: string
): void {
  const ownership = validateCleanupOwnership(target, expectedRunId);
  const tombstone = `${ownership.root}.cleanup-${expectedRunId}`;
  fs.renameSync(ownership.root, tombstone);
  const moved = fs.lstatSync(tombstone);
  if (
    moved.isSymbolicLink() ||
    moved.dev !== ownership.device ||
    moved.ino !== ownership.inode
  ) {
    throw new Error("cleanup target changed before deletion");
  }
  assertSentinel(tombstone, ownership.root, expectedRunId);
  fs.rmSync(tombstone, { recursive: true, force: false });
}

export function validateCleanupTarget(
  target: string,
  expectedRunId: string
): string {
  return validateCleanupOwnership(target, expectedRunId).root;
}

function validateCleanupOwnership(
  target: string,
  expectedRunId: string
): { root: string; device: number; inode: number } {
  if (!(target.trim() && path.isAbsolute(target))) {
    throw new Error("cleanup target must be a non-empty absolute path");
  }
  const canonical = fs.realpathSync(target);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (
    canonical === tempRoot ||
    path.dirname(canonical) !== tempRoot ||
    fs.lstatSync(target).isSymbolicLink()
  ) {
    throw new Error("cleanup target is not an owned harness root");
  }
  const stat = fs.lstatSync(target);
  assertSentinel(canonical, canonical, expectedRunId);
  return { root: canonical, device: stat.dev, inode: stat.ino };
}

export function cleanupCommand(root: string, runId: string): string {
  return [
    "pnpm -C apps/desktop exec tsx test/manual/desktop-operating-mode-manual.ts --cleanup",
    shellQuote(root),
    "--run-id",
    shellQuote(runId),
  ].join(" ");
}

/** Refuses any missing, blank, or outside-root collector home before launch. */
export function validateIsolatedHarnessHomes(
  root: string,
  homes: Record<string, string>
): void {
  for (const key of HARNESS_HOME_ENV_KEYS) {
    const value = homes[key];
    if (!(value && fs.existsSync(value) && isDescendant(root, value))) {
      throw new Error(`collector home isolation failed for ${key}`);
    }
  }
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, fs.realpathSync(candidate));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertSentinel(
  directory: string,
  expectedRoot: string,
  expectedRunId: string
): void {
  const sentinelPath = path.join(directory, SENTINEL_FILE);
  const stat = fs.lstatSync(sentinelPath);
  if (stat.isSymbolicLink() || stat.mode % 0o1000 !== 0o600) {
    throw new Error("cleanup sentinel ownership is invalid");
  }
  const sentinel = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as {
    root?: unknown;
    runId?: unknown;
  };
  if (sentinel.root !== expectedRoot || sentinel.runId !== expectedRunId) {
    throw new Error("cleanup sentinel does not match the exact run");
  }
}
