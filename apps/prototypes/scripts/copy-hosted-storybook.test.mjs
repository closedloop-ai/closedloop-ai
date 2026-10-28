/**
 * ISS-10991 — the prototypes build copies `storybook#build`'s output into
 * `public/storybook` rather than building Storybook itself.
 *
 * Each case runs the real script from a throwaway `apps/{prototypes,storybook}`
 * layout, with a stale hosted copy already in place, and reads its exit code
 * and what it left on disk. `TURBO_HASH` is removed from the child's env unless
 * a case sets it: this suite itself usually runs under turbo, which sets it.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_SOURCE = join(import.meta.dirname, "copy-hosted-storybook.mjs");
const SCRIPT_PATH = "apps/prototypes/scripts/copy-hosted-storybook.mjs";
const HOSTED_DIR = "apps/prototypes/public/storybook";
const BUILD_DIR = "apps/storybook/storybook-static";
const RERUN_HINT = "pnpm turbo run build --filter=prototypes";
const CASE_TIMEOUT_MS = 30_000;

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("copy-hosted-storybook", () => {
  it("replaces the hosted copy with storybook#build's output under turbo", () => {
    const root = layout({ built: true });

    const result = run(root, { TURBO_HASH: "0d5e7194d3494fe4" });

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, HOSTED_DIR, "index.html"), "utf8")).toBe(
      "fresh"
    );
    expect(existsSync(join(root, HOSTED_DIR, "stale.js"))).toBe(false);
  });

  it("refuses outside turbo, even with a build on disk, and copies nothing", () => {
    // A bare `pnpm --filter prototypes build` cannot tell a fresh
    // `storybook-static` from one left weeks ago, so it must not publish either.
    const root = layout({ built: true });

    const result = run(root, {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(RERUN_HINT);
    expect(existsSync(join(root, HOSTED_DIR, "stale.js"))).toBe(true);
    expect(existsSync(join(root, HOSTED_DIR, "index.html"))).toBe(false);
  });

  it("names the missing build instead of dying on a raw copy error", () => {
    const root = layout({ built: false });

    const result = run(root, { TURBO_HASH: "0d5e7194d3494fe4" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(root, BUILD_DIR));
    expect(result.stderr).toContain(RERUN_HINT);
    expect(result.stderr).not.toContain("ENOENT");
    expect(existsSync(join(root, HOSTED_DIR, "stale.js"))).toBe(true);
  });
});

function layout({ built }) {
  // Real path, because the child resolves its own location through symlinks
  // (macOS `/var` is `/private/var`) and its message names that path.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "copy-hosted-storybook-"))
  );
  roots.push(root);
  mkdirSync(join(root, "apps/prototypes/scripts"), { recursive: true });
  cpSync(SCRIPT_SOURCE, join(root, SCRIPT_PATH));
  mkdirSync(join(root, HOSTED_DIR), { recursive: true });
  writeFileSync(join(root, HOSTED_DIR, "stale.js"), "old");
  if (built) {
    mkdirSync(join(root, BUILD_DIR), { recursive: true });
    writeFileSync(join(root, BUILD_DIR, "index.html"), "fresh");
  }
  return root;
}

function run(root, env) {
  const childEnv = { ...process.env };
  Reflect.deleteProperty(childEnv, "TURBO_HASH");
  const result = spawnSync(process.execPath, [join(root, SCRIPT_PATH)], {
    env: { ...childEnv, ...env },
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}
