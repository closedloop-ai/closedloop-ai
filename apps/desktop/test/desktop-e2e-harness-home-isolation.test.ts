/**
 * @file desktop-e2e-harness-home-isolation.test.ts
 * @description ISS-7731 — a desktop E2E launch must never leave a collector home
 * ambient, whether or not the spec remembered to say so.
 *
 * `launchDesktopApp` spreads `...process.env`, so a launch pinning only
 * `{ CLAUDE_HOME, CODEX_HOME }` still resolved `CURSOR_HOME`, `COPILOT_HOME`,
 * `COPILOT_VSCODE_STORAGE_DIR`, `OPENCODE_DATA_DIR` and `OPENCODE_CONFIG_DIR`
 * under `os.homedir()` — so the boot collectors read the OPERATOR'S REAL Cursor,
 * Copilot and OpenCode history into the launch's SQLite store. ISS-7697 proved
 * that live: a real local Copilot session landed in a seeded Sessions population
 * on PR #5639. 89 spec/helper files were still in that shape.
 *
 * The fix inverts the default instead of editing 89 call sites, so the coverage
 * has to be about the LAUNCHER, not about any one spec. Three claims, and the
 * middle one is what stops the other two being a false green:
 *
 *   1. a launch that says NOTHING about collector homes still isolates all of
 *      them — verified by executing each shipped collector's REAL home resolver
 *      against the environment the launcher actually produced;
 *   2. a launch that deliberately seeds ONE home still gets that home (the
 *      default must not silently ignore a spec's override) while the other six
 *      stay isolated;
 *   3. dropping a single variable from the launcher's environment DOES put that
 *      resolver back under the operator's home — the ambient case, proving the
 *      resolver reads the variable at all rather than ignoring its environment.
 *
 * Claim 3 removes exactly ONE key rather than re-typing the pre-fix
 * `{ CLAUDE_HOME, CODEX_HOME }` pair. That is deliberate: re-typing the old pair
 * would leave Copilot and OpenCode inherited, so the control itself would read
 * the operator's real history on a dev machine — the trap the ISS-7697 control
 * fell into. Removing one key also isolates the experimental variable properly.
 *
 * Nothing here launches Electron. The `launchElectron` seam (ISS-6929) captures
 * the environment the launcher WOULD have spawned with, so the real merge order
 * runs and no collector ever opens a file. The resolvers are pure path
 * computation — `getClaudeHome()` and friends read no disk — so even the ambient
 * case only ever produces a STRING under `os.homedir()`, never a read of it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import { getClaudeDesktopSessionsDir } from "../src/main/collectors/claude/claude-desktop-origin.js";
import { getClaudeHome } from "../src/main/collectors/claude/claude-home.js";
import { getCodexHome } from "../src/main/collectors/codex/codex-home.js";
import {
  getCopilotCliHome,
  getVscodeWorkspaceStorageDir,
} from "../src/main/collectors/copilot/copilot-home.js";
import { getCursorHome } from "../src/main/collectors/cursor/cursor-home.js";
import {
  getOpenCodeConfigHome,
  getOpenCodeHome,
} from "../src/main/collectors/opencode/opencode-home.js";
import { launchAuthenticatedDesktopApp } from "./e2e/helpers/authenticated-desktop-app.js";
import {
  type ElectronLauncher,
  launchDesktopApp,
  launchGuardedElectronApp,
} from "./e2e/helpers/desktop-app.js";
import {
  HARNESS_HOME_ENV_KEYS,
  isolatedHarnessHomes,
} from "./helpers/isolated-harness-homes.js";
import { COLLECTOR_HOME_ENV } from "./perf/helpers/perf-run.js";

/**
 * Every home resolver the five shipped collectors reach disk through, keyed by
 * the variable that must redirect it.
 *
 * Stated deliberately: no runtime check can enumerate functions nobody
 * imported, so a NINTH collector home still has to be added here — but it is
 * added beside the variable it belongs to, and the key coverage below fails if
 * the canonical set and this table ever disagree.
 */
const HOME_RESOLVERS: Record<string, () => string> = {
  CLAUDE_HOME: getClaudeHome,
  // Review (#5717, tamsinb): the sidecar resolver is the one that can decline
  // to read at all — it returns `null` off macOS, where Claude Desktop has no
  // verified layout. `""` is the honest spelling of that here: `leakingHomes`
  // grades a path by whether it sits under `os.homedir()`, and "no tree is
  // read" is not a leak. It is NOT a free pass on macOS, where the same
  // resolver returns a real path under the operator's home unless pinned.
  CLAUDE_DESKTOP_SESSIONS_HOME: () => getClaudeDesktopSessionsDir() ?? "",
  CODEX_HOME: getCodexHome,
  CURSOR_HOME: getCursorHome,
  COPILOT_HOME: getCopilotCliHome,
  COPILOT_VSCODE_STORAGE_DIR: getVscodeWorkspaceStorageDir,
  OPENCODE_DATA_DIR: getOpenCodeHome,
  OPENCODE_CONFIG_DIR: getOpenCodeConfigHome,
};

/**
 * Lower-precedence OpenCode/XDG fallbacks the canonical set does not pin.
 *
 * Cleared while resolving so a case proves `OPENCODE_CONFIG_DIR` is the branch
 * that actually wins, rather than passing because an ambient `XDG_CONFIG_HOME`
 * happened to agree.
 */
const LOWER_PRECEDENCE_KEYS = [
  "OPENCODE_CONFIG",
  "XDG_CONFIG_HOME",
  "APPDATA",
] as const;

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * A launcher that records the environment it was handed and then fails.
 *
 * Recorded, never asserted here: an assertion inside an injected double is one
 * that can silently never run. Every case asserts from its own body, and
 * `onlyEnv` fails loudly if the launcher was never reached.
 */
function capturingLauncher(
  captured: Record<string, string | undefined>[]
): ElectronLauncher {
  return (launchOptions) => {
    captured.push({ ...launchOptions?.env });
    return Promise.reject(new Error("captured; no Electron was spawned"));
  };
}

function onlyEnv(
  captured: Record<string, string | undefined>[]
): Record<string, string | undefined> {
  const [env] = captured;
  if (captured.length !== 1 || !env) {
    throw new Error(
      `the injected launcher should have been reached exactly once, saw ${captured.length}`
    );
  }
  return env;
}

/**
 * Apply `env`, run every collector's REAL home resolver, and restore.
 *
 * The resolvers read `process.env` directly, which is the whole point: this
 * grades what the SHIPPED collector would compute at boot, not what the
 * launcher's object literal looks like. The previous values are restored
 * exactly — an originally-unset variable is deleted rather than assigned
 * `undefined`, which would leave the string "undefined" behind and point a
 * later test's collector at a directory named that.
 */
function resolveUnder(
  env: Record<string, string | undefined>
): Record<string, string> {
  const keys = [...HARNESS_HOME_ENV_KEYS, ...LOWER_PRECEDENCE_KEYS];
  const previous = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]])
  );
  const restore = (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    for (const key of keys) {
      const value = env[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    // Cleared unconditionally: these are strictly lower precedence than the
    // canonical set, so leaving an ambient one set could satisfy a resolver the
    // launcher never pinned and turn claim 3 green for the wrong reason.
    for (const key of LOWER_PRECEDENCE_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
    const resolved: Record<string, string> = {};
    for (const [key, resolve] of Object.entries(HOME_RESOLVERS)) {
      resolved[key] = resolve();
    }
    return resolved;
  } finally {
    restore();
  }
}

/** The variables whose resolver still lands under the operator's real home. */
function leakingHomes(env: Record<string, string | undefined>): string[] {
  const home = os.homedir();
  return Object.entries(resolveUnder(env))
    .filter(([, dir]) => dir.startsWith(home))
    .map(([key]) => key);
}

describe("desktop e2e launchers isolate collector homes by default (ISS-7731)", () => {
  test("the resolver table covers exactly the canonical variable set", () => {
    assert.deepEqual(
      Object.keys(HOME_RESOLVERS).sort(),
      [...HARNESS_HOME_ENV_KEYS].sort(),
      "the resolver table and the canonical isolation set disagree, so one of them is not covering a shipped collector"
    );
  });

  test("the perf harness's own collector-home map covers the same variable set", () => {
    // `perf-run.ts` keeps a SECOND map over these variables (its directory names
    // differ, so it cannot simply call `isolatedHarnessHomes`), and four perf
    // workloads resolve their homes from it. Without this pin, a sixth collector
    // added to the canonical set would leave those workloads resolving that home
    // under `os.homedir()` — the ISS-7731 leak, in the lane least likely to be
    // re-checked — while `isolated-harness-homes.ts` still claimed to be THE list.
    assert.deepEqual(
      Object.keys(COLLECTOR_HOME_ENV).sort(),
      [...HARNESS_HOME_ENV_KEYS].sort(),
      "the perf harness and the canonical isolation set disagree: one of them is missing a collector"
    );
  });

  test("a launch that says NOTHING about collector homes leaves none of them under the operator's home", async () => {
    const captured: Record<string, string | undefined>[] = [];
    await assert.rejects(() =>
      launchDesktopApp({
        userDataPrefix: "iss-7731-default-",
        launchElectron: capturingLauncher(captured),
      })
    );

    assert.deepEqual(
      leakingHomes(onlyEnv(captured)),
      [],
      "a default launch resolved a collector home under the operator's real home directory — the boot collectors would ingest their real agent history"
    );
  });

  test("the ambient control: dropping ONE variable puts exactly that resolver back under the operator's home", async () => {
    const captured: Record<string, string | undefined>[] = [];
    await assert.rejects(() =>
      launchDesktopApp({
        userDataPrefix: "iss-7731-ambient-",
        launchElectron: capturingLauncher(captured),
      })
    );

    // ONE key removed from the launcher's OWN output — never a re-typed
    // pre-fix pair, which would leave Copilot and OpenCode ambient and make this
    // control read the operator's real history.
    const dropped = "OPENCODE_DATA_DIR";
    const ambient = { ...onlyEnv(captured), [dropped]: undefined };

    assert.deepEqual(
      leakingHomes(ambient),
      [dropped],
      "removing a collector-home variable did NOT send its resolver under the operator's home — the resolver ignores its environment, so the default-isolation case above proves nothing"
    );
  });

  test("an inherited real home in the operator's own environment is overridden, not adopted", async () => {
    // The launcher spreads `...process.env`, so an operator who exports a home
    // (a non-default Claude install, a shell profile, a parent harness) hands it
    // straight to the launch. The choke-point backstop cannot catch this — a set
    // variable is not ambient — so this is the ONE case that grades the wrapper's
    // isolation layer specifically, and it is why that layer sits ABOVE
    // `...process.env` rather than relying on the backstop.
    //
    // A synthetic path under the home directory that is never created and never
    // read: no Electron is spawned and the resolvers only compute strings, so
    // this names the operator's home without touching anything in it.
    const inherited = path.join(os.homedir(), ".claude-iss7731-synthetic");
    const previous = process.env.CLAUDE_HOME;
    const captured: Record<string, string | undefined>[] = [];
    try {
      process.env.CLAUDE_HOME = inherited;
      await assert.rejects(() =>
        launchDesktopApp({
          userDataPrefix: "iss-7731-inherited-",
          launchElectron: capturingLauncher(captured),
        })
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "CLAUDE_HOME");
      } else {
        process.env.CLAUDE_HOME = previous;
      }
    }

    const env = onlyEnv(captured);
    assert.notEqual(
      env.CLAUDE_HOME,
      inherited,
      "the launch adopted the collector home exported in the operator's own environment — a real local Claude history would be ingested"
    );
    assert.deepEqual(
      leakingHomes(env),
      [],
      "an inherited collector home survived into the launch environment"
    );
  });

  test("a deliberately seeded home is honored, and the other six stay isolated", async () => {
    const seededCorpus = makeRoot("iss-7731-seeded-corpus-");
    const specRoot = makeRoot("iss-7731-spec-homes-");
    const captured: Record<string, string | undefined>[] = [];

    // The established seeded-corpus pattern (historical-import-utility-worker.spec.ts):
    // spread the canonical set, then override the ONE home that must point at a
    // seeded corpus. The default isolation sits UNDER this and must neither
    // break the override nor silently ignore it.
    await assert.rejects(() =>
      launchDesktopApp({
        userDataPrefix: "iss-7731-seeded-",
        env: { ...isolatedHarnessHomes(specRoot), CLAUDE_HOME: seededCorpus },
        launchElectron: capturingLauncher(captured),
      })
    );

    const env = onlyEnv(captured);
    assert.equal(
      resolveUnder(env).CLAUDE_HOME,
      seededCorpus,
      "the default isolation clobbered a spec's seeded corpus — a spec that seeds a harness home would silently assert against an empty one"
    );
    assert.deepEqual(
      leakingHomes(env),
      [],
      "overriding one home left another ambient"
    );
  });

  test("the authenticated launcher isolates by default too", async () => {
    const userDataDir = makeRoot("iss-7731-auth-udd-");
    const captured: Record<string, string | undefined>[] = [];

    await assert.rejects(() =>
      launchAuthenticatedDesktopApp({
        userDataDir,
        launchElectron: capturingLauncher(captured),
      })
    );

    assert.deepEqual(
      leakingHomes(onlyEnv(captured)),
      [],
      "the authenticated launcher resolved a collector home under the operator's real home directory"
    );
  });

  test("the authenticated launcher also overrides an inherited real home rather than adopting it", async () => {
    // The sibling of the `launchDesktopApp` case above, and needed for the same
    // reason: the case directly above exercises only the AMBIENT default, which
    // the shared choke-point backstop would keep green even if this launcher's
    // own isolation layer were deleted or moved below `...process.env`. A SET
    // variable is not ambient, so only this case grades that layer — and this
    // launcher backs the authenticated Branch E2E flows, so a leak here is the
    // ISS-7697 defect reintroduced on the second production launcher.
    const inherited = path.join(os.homedir(), ".claude-iss7731-synthetic-auth");
    const userDataDir = makeRoot("iss-7731-auth-inherited-udd-");
    const previous = process.env.CLAUDE_HOME;
    const captured: Record<string, string | undefined>[] = [];
    try {
      process.env.CLAUDE_HOME = inherited;
      await assert.rejects(() =>
        launchAuthenticatedDesktopApp({
          userDataDir,
          launchElectron: capturingLauncher(captured),
        })
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "CLAUDE_HOME");
      } else {
        process.env.CLAUDE_HOME = previous;
      }
    }

    const env = onlyEnv(captured);
    assert.notEqual(
      env.CLAUDE_HOME,
      inherited,
      "the authenticated launch adopted the collector home exported in the operator's own environment"
    );
    assert.deepEqual(
      leakingHomes(env),
      [],
      "an inherited collector home survived into the authenticated launch environment"
    );
  });

  test("the choke point backstops a caller that reaches it directly with an unpinned home", async () => {
    const callerRoot = makeRoot("iss-7731-backstop-");
    const captured: Record<string, string | undefined>[] = [];
    const dropped = "COPILOT_VSCODE_STORAGE_DIR";
    const pinned = isolatedHarnessHomes(callerRoot);
    // DELETED, not set to `undefined`: the choke point's env type is
    // `{ [key: string]: string }`, so an absent key is the only shape a real
    // caller could actually reach this with.
    const withOneAmbient = { ...pinned };
    Reflect.deleteProperty(withOneAmbient, dropped);

    // Precondition, not decoration: if this env did not actually leak, the
    // backstop assertion below would hold over a caller that needed no backstop.
    assert.deepEqual(
      leakingHomes(withOneAmbient),
      [dropped],
      "the unpinned-home fixture does not actually leak, so the backstop is untested"
    );

    await assert.rejects(() =>
      launchGuardedElectronApp({
        args: [],
        env: withOneAmbient,
        launchElectron: capturingLauncher(captured),
      })
    );

    const env = onlyEnv(captured);
    assert.deepEqual(
      leakingHomes(env),
      [],
      "a caller reaching the choke point directly with an unpinned home was allowed to launch against the operator's real history"
    );
    // The backstop fills ambient homes ONLY — it must never overwrite a home the
    // caller deliberately pinned, or a seeded corpus would vanish underneath it.
    assert.equal(
      env.CLAUDE_HOME,
      pinned.CLAUDE_HOME,
      "the backstop overwrote a home the caller had already pinned"
    );
  });
});
