/**
 * ISS-11596 fixtures for the binary-resolution call sites that moved from the
 * synchronous resolvers (`getResolvedGitPath`, `getResolvedClaudePath`,
 * `getShellPathSync`, `resolveBinaryFromLoginShellSync`) to their async twins.
 *
 * Two kinds of test use them:
 *
 * - Characterization tests (`git-path-call-sites-*.test.ts`) pin each caller's
 *   observable surface. They must pass unchanged on `origin/main` and on the
 *   branch, so they use only what both revisions share: a configured override
 *   that can be made unusable mid-flow ({@link revocableBinary}) and the
 *   runner's strict-override env ({@link assertStrictBinaryOverrides}).
 * - Main-thread tests (`git-path-main-thread-*.test.ts`) prove a cold
 *   login-shell probe no longer blocks the event loop. {@link coldShellProbe}
 *   writes a fake `$SHELL` that acknowledges a release ONLY while it is still
 *   running. On the synchronous resolver the event loop is blocked for the
 *   probe's whole life, so the observer cannot release it and the probe ends
 *   unacknowledged; a release that lands later reaches a dead process. A stale
 *   marker therefore cannot turn a blocked probe into a pass, which is the
 *   failure mode an `[observed, resolved]` ordering assertion had (PLN-2165,
 *   review finding B2).
 */

import { chmodSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { STRICT_BINARY_OVERRIDES_ENV_VAR } from "../../src/server/operations/binary-path-overrides.js";
import {
  resetShellPathCache,
  resetShellPathCacheOnlyForTest,
  withShellPathEnvForTest,
} from "../../src/server/shell-path.js";

const EXECUTABLE = 0o755;
const NOT_EXECUTABLE = 0o644;

/** Polling cadence of the probe observer; the release normally lands within one tick. */
const OBSERVER_POLL_MS = 10;

/**
 * How long a fake login shell (or an announcing fake binary) waits for its
 * release before giving up. Below `SHELL_PATH_TIMEOUT_MS` (5 s) so a blocked
 * synchronous probe ends on its own instead of being killed. No assertion
 * depends on it: a probe that gives up writes no acknowledgement.
 */
const WAIT_TENTHS = 40;

/** A fake executable that a test can make unusable at a chosen point. */
export type RevocableBinary = {
  path: string;
  /** Drop the executable bit, so the next resolution sees an unusable override. */
  revoke: () => void;
};

/** Write `script` as an executable at `dir/name`, revocable later. */
export function revocableBinary(
  dir: string,
  name: string,
  script: string
): RevocableBinary {
  const binaryPath = path.join(dir, name);
  writeFileSync(binaryPath, script, { mode: EXECUTABLE });
  return {
    path: binaryPath,
    revoke: () => chmodSync(binaryPath, NOT_EXECUTABLE),
  };
}

/**
 * The runner (`scripts/run-node-tests.mjs`) exports `DESKTOP_TEST_STRICT_ENV`,
 * which makes an unusable git override throw the ISS-10194 refusal in both git
 * resolvers. The failure cases depend on it, so they assert it rather than set it.
 */
export function assertStrictBinaryOverrides(): void {
  if (process.env[STRICT_BINARY_OVERRIDES_ENV_VAR] !== "1") {
    throw new Error(
      `${STRICT_BINARY_OVERRIDES_ENV_VAR}=1 is required (set by scripts/run-node-tests.mjs)`
    );
  }
}

/** The refusal both git resolvers throw for an unusable override under strict mode. */
export function strictRefusalPattern(overridePath: string): RegExp {
  return new RegExp(
    `Binary override for "git" is configured but not executable: ${escapeRegExp(overridePath)}`
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which PATH cache the observer resets between two resolutions of one flow. */
export const CacheScope = {
  /** The `withShellPathEnvForTest` context the observer was started in. */
  Context: "context",
  /** The process-wide cache, for flows that run through the HTTP gateway. */
  Global: "global",
} as const;
export type CacheScope = (typeof CacheScope)[keyof typeof CacheScope];

export type ColdShellProbe = {
  /** The fake `$SHELL` to put in the env the resolver reads. */
  shell: string;
  /** The directory the fake shell reports as PATH; put fake binaries here. */
  binDir: string;
  /** Marker directory shared by the shell, announcing binaries and the observer. */
  probeDir: string;
  /** An env whose `SHELL` is the fake shell and whose `PATH` holds `binDir`. */
  env: NodeJS.ProcessEnv;
  /**
   * Shell lines for a fake binary that, before doing its work, announces
   * `name` and waits until the observer has reset the PATH cache, so the next
   * resolution in the flow is guaranteed cold.
   */
  announceLines: (name: string) => string[];
  /**
   * Reset the cache now and record the reset under `name`. For in-process seams
   * (a `FakeProcessManager` hook, a scripted fetch) that run between two
   * resolutions of one flow.
   */
  resetNow: (name: string) => void;
  /** Start the observer. Call it inside the context whose cache it resets. */
  start: () => void;
  stop: () => void;
  /** Snapshot of every probe so far, in start order. */
  state: () => Promise<ProbeState>;
};

export type ProbeState = {
  /** Probe ids in the order the observer saw them start. */
  started: string[];
  /** Probes that never received a release while alive. */
  unacked: string[];
  /** Probe ids that started after the reset recorded under each name. */
  startedAfterReset: (name: string) => string[];
};

/**
 * Build a fake login shell plus the observer that releases it. See the file
 * header for why acknowledgement, not ordering, is the discriminating signal.
 */
export async function coldShellProbe(options: {
  root: string;
  scope: CacheScope;
}): Promise<ColdShellProbe> {
  const binDir = path.join(options.root, "probe-bin");
  const probeDir = path.join(options.root, "probe-markers");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(probeDir, { recursive: true });
  const shell = path.join(options.root, "fake-login-shell");
  await fs.writeFile(
    shell,
    [
      "#!/bin/sh",
      `d=${JSON.stringify(probeDir)}`,
      ': > "$d/started-$$"',
      "i=0",
      `while [ ! -f "$d/release-$$" ]; do i=$((i + 1)); if [ "$i" -gt ${WAIT_TENTHS} ]; then break; fi; sleep 0.1; done`,
      'if [ -f "$d/release-$$" ]; then : > "$d/ack-$$"; fi',
      `echo "__CLPATH_START__${binDir}:/usr/bin:/bin__CLPATH_END__"`,
      "",
    ].join("\n"),
    { mode: EXECUTABLE }
  );

  const order: string[] = [];
  const released = new Set<string>();
  const handledAnnouncements = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const reset = (): void => {
    if (options.scope === CacheScope.Context) {
      resetShellPathCacheOnlyForTest();
    } else {
      resetShellPathCache();
    }
  };

  const recordReset = (name: string): void => {
    reset();
    order.push(`reset:${name}`);
  };

  const poll = async (): Promise<void> => {
    const names = await fs.readdir(probeDir);
    for (const name of names) {
      if (name.startsWith("started-")) {
        const id = name.slice("started-".length);
        if (!released.has(id)) {
          released.add(id);
          order.push(`probe:${id}`);
          await fs.writeFile(path.join(probeDir, `release-${id}`), "");
        }
      } else if (name.startsWith("announce-")) {
        const announced = name.slice("announce-".length);
        if (!handledAnnouncements.has(announced)) {
          handledAnnouncements.add(announced);
          recordReset(announced);
          await fs.writeFile(
            path.join(probeDir, `reset-done-${announced}`),
            ""
          );
        }
      }
    }
  };

  return {
    shell,
    binDir,
    probeDir,
    env: {
      ...process.env,
      SHELL: shell,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    announceLines: (name) => [
      `: > ${JSON.stringify(path.join(probeDir, `announce-${name}`))}`,
      "i=0",
      `while [ ! -f ${JSON.stringify(path.join(probeDir, `reset-done-${name}`))} ]; do i=$((i + 1)); if [ "$i" -gt ${WAIT_TENTHS} ]; then break; fi; sleep 0.1; done`,
    ],
    resetNow: recordReset,
    start: () => {
      timer = setInterval(() => {
        poll().catch(() => {
          // A marker that vanished mid-scan is picked up on the next tick.
        });
      }, OBSERVER_POLL_MS);
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    state: async () => {
      // Pick up any probe that started after the last tick.
      await poll();
      const names = new Set(await fs.readdir(probeDir));
      const started = order
        .filter((entry) => entry.startsWith("probe:"))
        .map((entry) => entry.slice("probe:".length));
      return {
        started,
        unacked: started.filter((id) => !names.has(`ack-${id}`)),
        startedAfterReset: (name) => {
          const index = order.indexOf(`reset:${name}`);
          if (index === -1) {
            return [];
          }
          return order
            .slice(index + 1)
            .filter((entry) => entry.startsWith("probe:"))
            .map((entry) => entry.slice("probe:".length));
        },
      };
    },
  };
}

/**
 * Restore `process.env` keys a test changed, deleting the ones that were unset
 * before (assigning `undefined` would store the string "undefined").
 */
export function snapshotEnv(keys: readonly string[]): () => void {
  const saved = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]])
  );
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
}

/**
 * Run `fn` inside a fresh shell-path context whose login shell is the probe's
 * fake shell, with the observer running for exactly that span.
 */
export async function withColdShell<T>(
  probe: ColdShellProbe,
  fn: () => Promise<T>
): Promise<T> {
  return await withShellPathEnvForTest(probe.env, async () => {
    probe.start();
    try {
      return await fn();
    } finally {
      probe.stop();
    }
  });
}

/**
 * Every login-shell probe that started was released while still running. With
 * `afterReset`, also require at least one probe attributable to the resolution
 * that followed that reset, so the case cannot pass on an earlier site alone.
 */
export async function assertProbesNeverBlocked(
  probe: ColdShellProbe,
  afterReset?: string
): Promise<void> {
  const state = await probe.state();
  if (state.started.length === 0) {
    throw new Error("no login-shell probe ran");
  }
  if (
    afterReset !== undefined &&
    state.startedAfterReset(afterReset).length === 0
  ) {
    throw new Error(`no login-shell probe ran after the "${afterReset}" reset`);
  }
  if (state.unacked.length > 0) {
    throw new Error(
      `a login-shell probe was never released while it ran, so the resolution blocked the event loop (unacknowledged probes: ${state.unacked.join(", ")})`
    );
  }
}
