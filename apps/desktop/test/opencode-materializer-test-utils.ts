/**
 * @file opencode-materializer-test-utils.ts
 * @description Shared harness for the OpenCode materializer suites: the fake
 * in-memory filesystem the materializer's `fsImpl` seam accepts, the DB-stat
 * fixtures its fingerprint reads, and the load/linkage wrappers for its two DB
 * seams. Extracted from `opencode-materializer.test.ts` (ISS-5337) so a focused
 * sibling suite can reuse it instead of re-deriving it, and so that suite stops
 * creeping toward the 1,000-line ceiling.
 */
import type { OpencodeSessionLoad } from "../src/main/collectors/opencode/opencode-parse-failure.js";
import {
  type OpencodeParentLinkRead,
  OpencodeParentLinkReadStatus,
  type OpencodeSessionLink,
} from "../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { opencodeMaterializedRoot } from "../src/main/transcript-sync/opencode-materializer.js";

/**
 * ISS-5238 (F3): the loader seam now returns the LOAD (sessions + the sessions it
 * had to drop), because the prune deletes every projection the load did not
 * account for. This wraps a plain session list as a LOSSLESS load.
 */
export function loaded(sessions: NormalizedSession[]): OpencodeSessionLoad {
  return { sessions, droppedSessions: [] };
}

export const STATE_DIR = "/state";
export const HOME = "/opencode-home";

export type FakeDirent = {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
};

export type FakeFs = {
  files: Map<string, string>;
  stats: Map<string, { mtimeMs: number; size: number }>;
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { mtimeMs: number; size: number };
  mkdirSync: (p: string, opts?: unknown) => void;
  writeFileSync: (p: string, data: string) => void;
  readFileSync: (p: string, enc?: unknown) => string;
  renameSync: (from: string, to: string) => void;
  rmSync: (p: string, opts?: unknown) => void;
  readdirSync: (p: string, opts?: unknown) => FakeDirent[];
};

/** Immediate children of `dir` derived from the flat file map. */
export function listChildren(
  files: Map<string, string>,
  dir: string
): FakeDirent[] {
  const prefix = `${dir}/`;
  const childDirs = new Set<string>();
  const childFiles = new Set<string>();
  for (const filePath of files.keys()) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      childFiles.add(rest);
    } else {
      childDirs.add(rest.slice(0, slash));
    }
  }
  const dirents: FakeDirent[] = [];
  for (const name of childDirs) {
    dirents.push({ name, isDirectory: () => true, isFile: () => false });
  }
  for (const name of childFiles) {
    dirents.push({ name, isDirectory: () => false, isFile: () => true });
  }
  return dirents;
}

export function fakeFs(
  initialStats: Record<string, { mtimeMs: number; size: number }> = {}
): FakeFs {
  const files = new Map<string, string>();
  const stats = new Map(Object.entries(initialStats));
  return {
    files,
    stats,
    existsSync: (p) => files.has(p),
    statSync: (p) => {
      const stat = stats.get(p);
      if (!stat) {
        throw new Error(`ENOENT ${p}`);
      }
      return stat;
    },
    mkdirSync: () => undefined,
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    readFileSync: (p) => {
      const content = files.get(p);
      if (content === undefined) {
        throw new Error(`ENOENT ${p}`);
      }
      return content;
    },
    renameSync: (from, to) => {
      const content = files.get(from);
      if (content === undefined) {
        throw new Error(`ENOENT ${from}`);
      }
      files.delete(from);
      files.set(to, content);
    },
    rmSync: (p) => {
      files.delete(p);
    },
    readdirSync: (p) => {
      const children = listChildren(files, p);
      if (children.length === 0 && !hasDescendant(files, p)) {
        throw new Error(`ENOENT ${p}`);
      }
      return children;
    },
  };
}

/** True when any file lives under `dir` (so the dir "exists" for readdir). */
export function hasDescendant(
  files: Map<string, string>,
  dir: string
): boolean {
  const prefix = `${dir}/`;
  for (const filePath of files.keys()) {
    if (filePath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** Stats for the DB + WAL/SHM triple keyed by their in-home paths. */
export function dbStats(mtimeMs: number, size: number) {
  return {
    [`${HOME}/opencode.db`]: { mtimeMs, size },
    [`${HOME}/opencode.db-wal`]: { mtimeMs, size },
    [`${HOME}/opencode.db-shm`]: { mtimeMs, size },
  };
}

export const ROOT = opencodeMaterializedRoot(STATE_DIR);

/** A SUCCESSFUL linkage read carrying `links` (ISS-4649 `readParentLinks` seam). */
export function linked(links: OpencodeSessionLink[]): OpencodeParentLinkRead {
  return { links, status: OpencodeParentLinkReadStatus.Linked };
}
