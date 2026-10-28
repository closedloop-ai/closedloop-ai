import { execFile as execFileWithCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Bind-mount visibility for Docker-backed integration fixtures (ISS-10032).
 *
 * A VM-backed daemon (Dory, colima, Docker Desktop) shares only selected host
 * directories into its VM. A bind mount whose source is outside that set does
 * NOT error — the daemon mounts an EMPTY directory in its place, so "nothing
 * there" and "nothing mounted" become indistinguishable and the fixture fails
 * later wearing an unrelated error's clothes.
 *
 * This is the same fault and the same remedy shape as ISS-9883 / PR #7048
 * (`packages/telemetry-contract/collector-verification/run-verification.ts`):
 * anchor the source under `$HOME`, then read a per-run token back out through
 * the daemon and refuse naming the path. That module is NOT imported here:
 * `@closedloop-ai/telemetry-contract` is a deliberate leaf package that takes
 * no `@repo/*` runtime dependency and does not export its Docker orchestration
 * (see its `app.ts` and `src/resource.ts` notes), so importing across that
 * boundary — in either direction — is the coupling the boundary exists to stop.
 */

const execFile = promisify(execFileWithCallback);

/** Carries the per-run probe token inside the bind source. */
export const BIND_MOUNT_PROBE_FILE = "bind-mount-probe";

/**
 * The Docker daemon cannot see a bind-mount source. Fatal on purpose: nothing
 * was exercised, and the fix is on the caller's machine, not in the fixture.
 */
export class BindMountNotVisibleError extends Error {
  constructor(hostPath: string, symptom: string) {
    super(
      [
        `the Docker daemon cannot see the bind-mount source ${hostPath} (${symptom}).`,
        "The daemon runs in a VM that shares only selected host directories (Dory, colima, Docker Desktop) and this path is not one of them.",
        `Remedy: share ${path.dirname(hostPath)}, or a parent of it such as your home directory, with the Docker VM, then re-run.`,
      ].join("\n")
    );
    this.name = "BindMountNotVisibleError";
  }
}

/**
 * Create a scratch directory that a VM-backed daemon can actually bind.
 *
 * `os.tmpdir()` is the wrong anchor: on macOS it resolves under `/var/folders`,
 * which Dory does not share, so the mount comes up empty. `$HOME` is the one
 * host directory every VM-backed runtime shares by default.
 */
export async function makeVisibleBindSource(prefix: string): Promise<string> {
  const parent = path.join(homedir(), ".cache");
  await mkdir(parent, { recursive: true });
  return await mkdtemp(path.join(parent, prefix));
}

/**
 * Write a per-run token into `hostPath` and read it back through the daemon.
 *
 * Resolves when the token comes back, throws `BindMountNotVisibleError` when it
 * does not, naming which miss it was: an empty read (the unshared-source
 * signature) and a read holding someone else's content (a different or stale
 * directory mounted in its place) are different faults on the operator's
 * machine and must not wear each other's words. A failure of the probe command
 * itself (daemon unreachable, image missing, or a runtime that refuses the bind
 * outright) propagates raw: unlike otelcol's "cannot resolve the configuration",
 * those already name their own cause, and the defect being guarded here is
 * SILENCE, not a differently-worded loud error.
 */
export async function assertBindMountVisible(args: {
  readonly hostPath: string;
  readonly image: string;
  readonly readProbe?: (hostPath: string, image: string) => Promise<string>;
}): Promise<void> {
  const token = randomUUID();
  await writeFile(path.join(args.hostPath, BIND_MOUNT_PROBE_FILE), token);
  const readProbe = args.readProbe ?? readProbeThroughDaemon;
  const readBack = await readProbe(args.hostPath, args.image);
  if (!readBack.includes(token)) {
    throw new BindMountNotVisibleError(
      args.hostPath,
      describeProbeMiss(readBack)
    );
  }
}

// `|| true` so a missing file is an empty read rather than a non-zero exit:
// the decision is "did this run's token come back", and letting `cat` fail
// would blur the empty mount into every other reason the command can fail.
async function readProbeThroughDaemon(
  hostPath: string,
  image: string
): Promise<string> {
  const { stdout } = await execFile("docker", [
    "run",
    "--rm",
    "--volume",
    `${hostPath}:/bind-mount-probe-dir:ro`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    `cat /bind-mount-probe-dir/${BIND_MOUNT_PROBE_FILE} 2>/dev/null || true`,
  ]);
  return stdout;
}

/** Keeps a foreign probe read quotable in one line of an error message. */
const PROBE_SNIPPET_LIMIT = 80;

function describeProbeMiss(readBack: string): string {
  const found = readBack.trim();
  if (found === "") {
    return `${BIND_MOUNT_PROBE_FILE} came back empty from inside the container, so the daemon mounted an empty directory in its place`;
  }
  return `${BIND_MOUNT_PROBE_FILE} came back holding ${JSON.stringify(found.slice(0, PROBE_SNIPPET_LIMIT))} instead of this run's token, so the daemon mounted a different or stale directory in its place`;
}
