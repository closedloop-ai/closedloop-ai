/**
 * ISS-12394 — branch coverage for `scripts/smoke-linux-package.mjs`.
 *
 * The launch and runtime-check branches need a packaged Electron binary and a
 * display, which the node lane has neither of. Each case runs the real
 * entrypoint in a child with a preload whose module hook resolves
 * `@playwright/test` to a double. The double records the launch options it
 * was handed, plays back a scripted runtime, and records `close()`. The
 * runtime callback runs in the child, so the double reports the plan's
 * platform for that call rather than the host's.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT = join(DESKTOP_DIR, "scripts", "smoke-linux-package.mjs");
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 120_000;
const SMOKE_HOME_PREFIX = "closedloop-linux-smoke-";
const DID_NOT_START_PATTERN =
  /The packaged Linux application did not start correctly/;
const LAUNCHED_PATTERN = /Linux packaged application launched/;

const FAKE_PLAYWRIGHT_SOURCE = `
import { writeFileSync } from "node:fs";
const plan = JSON.parse(process.env.ISS12394_ELECTRON_PLAN);
export const _electron = {
  async launch(options) {
    writeFileSync(plan.capture, JSON.stringify({ args: options.args, env: options.env }));
    return {
      async firstWindow() {
        return { async waitForFunction() {} };
      },
      async evaluate(fn) {
        const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        Object.defineProperty(process, "platform", { value: plan.platform });
        try {
          return fn({
            app: { isPackaged: plan.packaged, getVersion: () => plan.version },
          });
        } finally {
          Object.defineProperty(process, "platform", hostPlatform);
        }
      },
      async close() {
        writeFileSync(plan.capture + ".closed", "1");
      },
    };
  },
};
`;

type ElectronPlan = {
  packaged: boolean;
  platform: NodeJS.Platform;
  version: string;
};
type Captured = { args: string[]; env: Record<string, string> };

let sandbox = "";
let tempRoot = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "smoke-linux-package-iss12394-"));
  tempRoot = join(sandbox, "tmp");
  mkdirSync(tempRoot);
});

afterEach(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

function runSmoke(plan: ElectronPlan, env: NodeJS.ProcessEnv) {
  const fakeModule = join(sandbox, "fake-playwright.mjs");
  writeFileSync(fakeModule, FAKE_PLAYWRIGHT_SOURCE);
  const preload = join(sandbox, "preload.mjs");
  writeFileSync(
    preload,
    `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@playwright/test") {
      return { url: ${JSON.stringify(pathToFileURL(fakeModule).href)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
`
  );
  const capture = join(sandbox, "capture.json");
  const result = spawnSync(
    process.execPath,
    ["--import", preload, ENTRYPOINT, "/opt/closedloop/closedloop"],
    {
      cwd: DESKTOP_DIR,
      encoding: "utf8",
      env: {
        ...env,
        TMPDIR: tempRoot,
        ISS12394_ELECTRON_PLAN: JSON.stringify({ ...plan, capture }),
      },
      killSignal: "SIGKILL",
      timeout: SPAWN_TIMEOUT_MS,
    }
  );
  if (result.error) {
    throw new Error(
      `smoke-linux-package did not exit: ${result.error.message}`
    );
  }
  return {
    ...result,
    captured: JSON.parse(readFileSync(capture, "utf8")) as Captured,
    closed: existsSync(`${capture}.closed`),
    leftoverHomes: readdirSync(tempRoot).filter((entry) =>
      entry.startsWith(SMOKE_HOME_PREFIX)
    ),
  };
}

/** `process.env` minus the keys the launch env reads with a fallback. */
function envWithout(keys: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of keys) {
    Reflect.deleteProperty(env, key);
  }
  return env;
}

describe("ISS-12394: smoke-linux-package launch", () => {
  it(
    "reports the version of a packaged Linux app, then closes it and removes its home",
    () => {
      const run = runSmoke(
        { packaged: true, platform: "linux", version: "1.2.3" },
        {
          ...process.env,
          PATH: "/custom/bin",
          DISPLAY: ":42",
          XAUTHORITY: "/run/xauth",
        }
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "Linux packaged application launched: 1.2.3"
      );
      expect(run.captured.env.PATH).toBe("/custom/bin");
      expect(run.captured.env.DISPLAY).toBe(":42");
      expect(run.captured.env.XAUTHORITY).toBe("/run/xauth");
      expect(
        run.captured.env.HOME.startsWith(join(tempRoot, SMOKE_HOME_PREFIX))
      ).toBe(true);
      expect(run.captured.env.CODEX_HOME).toBe(
        join(run.captured.env.HOME, ".codex")
      );
      expect(run.captured.args).toContain(
        `--user-data-dir=${join(run.captured.env.HOME, "user-data")}`
      );
      expect(run.closed).toBe(true);
      expect(run.leftoverHomes).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "falls back to a default PATH and DISPLAY and omits an unset XAUTHORITY",
    () => {
      const run = runSmoke(
        { packaged: true, platform: "linux", version: "1.2.3" },
        envWithout(["PATH", "DISPLAY", "XAUTHORITY"])
      );
      expect(run.status).toBe(0);
      expect(run.captured.env.PATH).toBe("/usr/bin:/bin");
      expect(run.captured.env.DISPLAY).toBe(":99");
      expect(Object.hasOwn(run.captured.env, "XAUTHORITY")).toBe(false);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "omits an empty XAUTHORITY",
    () => {
      const run = runSmoke(
        { packaged: true, platform: "linux", version: "1.2.3" },
        { ...process.env, XAUTHORITY: "" }
      );
      expect(run.status).toBe(0);
      expect(Object.hasOwn(run.captured.env, "XAUTHORITY")).toBe(false);
    },
    CASE_TIMEOUT_MS
  );
});

describe("ISS-12394: smoke-linux-package runtime check", () => {
  for (const [label, plan] of [
    [
      "an unpackaged app",
      { packaged: false, platform: "linux", version: "1.2.3" },
    ],
    [
      "an app with no version",
      { packaged: true, platform: "linux", version: "" },
    ],
    [
      "an app that is not running on Linux",
      { packaged: true, platform: "darwin", version: "1.2.3" },
    ],
  ] as const) {
    it(
      `fails ${label}, still closing it and removing its home`,
      () => {
        const run = runSmoke(plan, process.env);
        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(DID_NOT_START_PATTERN);
        expect(run.stdout).not.toMatch(LAUNCHED_PATTERN);
        expect(run.closed).toBe(true);
        expect(run.leftoverHomes).toEqual([]);
      },
      CASE_TIMEOUT_MS
    );
  }
});
