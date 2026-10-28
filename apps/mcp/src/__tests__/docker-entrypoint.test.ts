/**
 * ISS-8264 — the container entrypoint that derives V8's old-space ceiling from
 * the cgroup limit. It is the only thing standing between the ECS task's
 * `memory` and V8 self-sizing to roughly half of it, and it is shell, so a
 * later edit that silently stops exporting NODE_OPTIONS produces no error at
 * all: the container starts, serves traffic, and aborts under load exactly the
 * way ISS-8264 did.
 *
 * Every case runs the REAL script with `sh` against a fixture cgroup tree and
 * asserts what the exec'd process actually receives. Nothing is read from the
 * script's source text.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ENTRYPOINT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "docker-entrypoint.sh"
);

const MIB = 1024 * 1024;

let fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots = [];
});

/** Writes a fixture cgroup tree and returns its root. */
function cgroupTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-entrypoint-"));
  fixtureRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  return root;
}

/**
 * Runs the entrypoint and returns the NODE_OPTIONS the exec'd command sees.
 * The script ends in `exec "$@"`, so echoing from the argument command is the
 * observable — an assertion on the script's own output would not prove the
 * value survived the exec.
 */
function nodeOptionsAfterEntrypoint(env: NodeJS.ProcessEnv): {
  status: number | null;
  nodeOptions: string;
} {
  // The inner shell does not inherit `set -u`, so an unset NODE_OPTIONS simply
  // prints empty.
  const result = spawnSync(
    "sh",
    [ENTRYPOINT, "sh", "-c", 'printf "%s" "$NODE_OPTIONS"'],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } }
  );
  if (result.error) {
    throw result.error;
  }
  // The script logs its own decision to stdout before exec'ing, so only the
  // final line is the exec'd process's view of NODE_OPTIONS.
  const lastLine = result.stdout.split("\n").at(-1) ?? "";
  return { status: result.status, nodeOptions: lastLine.trim() };
}

describe("the MCP container entrypoint derives the heap ceiling", () => {
  it("reads the cgroup v2 limit and reserves non-heap RSS", () => {
    const root = cgroupTree({ "memory.max": `${2048 * MIB}\n` });

    const { status, nodeOptions } = nodeOptionsAfterEntrypoint({
      CGROUP_ROOT: root,
    });

    expect(status).toBe(0);
    // 2048 MiB granted, 512 MiB reserved for tsx sources, Prisma and native
    // buffers. A bare percentage would drift as that reserve stays constant.
    expect(nodeOptions).toBe("--max-old-space-size=1536");
  });

  it("falls back to the cgroup v1 limit file", () => {
    const root = cgroupTree({
      "memory/memory.limit_in_bytes": `${1024 * MIB}\n`,
    });

    const { nodeOptions } = nodeOptionsAfterEntrypoint({ CGROUP_ROOT: root });

    expect(nodeOptions).toBe("--max-old-space-size=512");
  });

  it("prefers the v2 file when both are present", () => {
    const root = cgroupTree({
      "memory.max": `${2048 * MIB}\n`,
      "memory/memory.limit_in_bytes": `${1024 * MIB}\n`,
    });

    const { nodeOptions } = nodeOptionsAfterEntrypoint({ CGROUP_ROOT: root });

    expect(nodeOptions).toBe("--max-old-space-size=1536");
  });

  it("leaves an operator's explicit NODE_OPTIONS untouched", () => {
    const root = cgroupTree({ "memory.max": `${2048 * MIB}\n` });

    const { nodeOptions } = nodeOptionsAfterEntrypoint({
      CGROUP_ROOT: root,
      NODE_OPTIONS: "--max-old-space-size=256",
    });

    expect(nodeOptions).toBe("--max-old-space-size=256");
  });

  it("leaves V8's default in place when the limit is unbounded", () => {
    // cgroup v2 writes the literal string for no limit.
    const root = cgroupTree({ "memory.max": "max\n" });

    const { nodeOptions } = nodeOptionsAfterEntrypoint({ CGROUP_ROOT: root });

    expect(nodeOptions).toBe("");
  });

  it("leaves V8's default in place when v1 reports its unbounded sentinel", () => {
    // cgroup v1 reports ~8 EiB rather than a word, so the plausibility ceiling
    // is what rejects it — the non-numeric guard never sees this one.
    const root = cgroupTree({
      "memory/memory.limit_in_bytes": "9223372036854771712\n",
    });

    const { nodeOptions } = nodeOptionsAfterEntrypoint({ CGROUP_ROOT: root });

    expect(nodeOptions).toBe("");
  });

  it("leaves V8's default in place when the limit cannot fund a usable heap", () => {
    // 640 MiB leaves 128 MiB after the reserve, below the 256 MiB floor.
    // Setting it anyway would trade a clean abort for an immediate one.
    const root = cgroupTree({ "memory.max": `${640 * MIB}\n` });

    const { nodeOptions } = nodeOptionsAfterEntrypoint({ CGROUP_ROOT: root });

    expect(nodeOptions).toBe("");
  });

  it("leaves V8's default in place when no cgroup files exist", () => {
    const root = cgroupTree({});

    const { status, nodeOptions } = nodeOptionsAfterEntrypoint({
      CGROUP_ROOT: root,
    });

    // `set -eu` plus an unreadable limit must still exec the command.
    expect(status).toBe(0);
    expect(nodeOptions).toBe("");
  });
});
