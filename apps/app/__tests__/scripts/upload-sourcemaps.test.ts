import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DD_SOURCEMAP_UPLOAD_FLAG } from "@/lib/datadog-rum/source-maps";
import { finalizeBrowserSourceMaps } from "@/scripts/upload-sourcemaps.mjs";

const created: string[] = [];

/** The one failure the build is allowed to have: a map in the served tree. */
const REFUSING_TO_SHIP = /refusing to ship/;

function makeBuildDir(): { cwd: string; mapFile: string; jsFile: string } {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "sourcemaps-"));
  created.push(cwd);
  const staticDir = path.join(cwd, ".next", "static", "chunks");
  mkdirSync(staticDir, { recursive: true });
  const mapFile = path.join(staticDir, "main-abc123.js.map");
  const jsFile = path.join(staticDir, "main-abc123.js");
  writeFileSync(mapFile, '{"version":3,"sources":["../src/x.ts"]}');
  writeFileSync(jsFile, "console.log(1)");
  return { cwd, mapFile, jsFile };
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("finalizeBrowserSourceMaps", () => {
  it("does nothing when the flag is off and the build emitted no maps", () => {
    const { cwd, mapFile } = makeBuildDir();
    rmSync(mapFile);
    const runner = vi.fn();

    expect(() => finalizeBrowserSourceMaps({}, cwd, runner)).not.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses to ship a map in .next/static even when the flag is off", () => {
    const { cwd, mapFile } = makeBuildDir();

    // ISS-8925 moved the question from "did my delete succeed" to "is a map in
    // the tree that gets served". The old guard returned before looking
    // whenever the flag was off, so it could only ever see maps it had emitted
    // itself — and a map put there by a config change, a dependency, or a
    // restored build cache is the same disclosure.
    expect(() => finalizeBrowserSourceMaps({}, cwd)).toThrow(REFUSING_TO_SHIP);
    expect(existsSync(mapFile)).toBe(true);
  });

  it("strips the maps when the flag is on but no API key is present", () => {
    const { cwd, mapFile, jsFile } = makeBuildDir();

    finalizeBrowserSourceMaps({ [DD_SOURCEMAP_UPLOAD_FLAG]: "true" }, cwd);

    // .next/static is served publicly, so a build that emitted maps must not
    // ship them even when the upload could not run.
    expect(existsSync(mapFile)).toBe(false);
    expect(existsSync(jsFile)).toBe(true);
  });

  it("skips the upload when the version resolves but no API key is present", () => {
    const { cwd } = makeBuildDir();
    const runner = vi.fn();

    finalizeBrowserSourceMaps(
      {
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        NEXT_PUBLIC_DATADOG_RUM_VERSION: "v1",
      },
      cwd,
      runner
    );

    expect(runner).not.toHaveBeenCalled();
  });

  it("strips the maps when no release version can be resolved", () => {
    const { cwd, mapFile } = makeBuildDir();

    finalizeBrowserSourceMaps(
      { [DD_SOURCEMAP_UPLOAD_FLAG]: "true", DD_API_KEY: "key" },
      cwd
    );

    expect(existsSync(mapFile)).toBe(false);
  });

  it("strips the maps even when the upload itself throws", () => {
    const { cwd, mapFile, jsFile } = makeBuildDir();
    const boom = () => {
      throw new Error("datadog-ci exploded");
    };

    finalizeBrowserSourceMaps(
      {
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        DD_API_KEY: "key",
        NEXT_PUBLIC_DATADOG_RUM_VERSION: "deadbeef",
      },
      cwd,
      boom
    );

    // The strip lives in a `finally` precisely for this path: a build that
    // emitted maps must never leave them in publicly served .next/static,
    // however the upload ends.
    expect(existsSync(mapFile)).toBe(false);
    expect(existsSync(jsFile)).toBe(true);
  });

  it("passes the gated key and resolved version through to the runner", () => {
    const { cwd } = makeBuildDir();
    const calls: {
      version: string;
      env: Record<string, string | undefined>;
    }[] = [];

    finalizeBrowserSourceMaps(
      {
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        DD_API_KEY: "key-123",
        VERCEL_GIT_COMMIT_SHA: "sha-abc",
        NEXT_PUBLIC_DATADOG_RUM_VERSION: "rum-v1",
      },
      cwd,
      (version, _dir, env) => calls.push({ version, env })
    );

    expect(calls).toHaveLength(1);
    // Must match what RUM tags events with, or Datadog cannot join them.
    // `resolveDatadogRumBuildVersion` prefers NEXT_PUBLIC_DATADOG_RUM_VERSION
    // over the commit sha off Vercel, and this resolves in the same order.
    expect(calls[0].version).toBe("rum-v1");
    expect(calls[0].env.DATADOG_API_KEY).toBe("key-123");
  });

  it("falls back to the commit sha when no explicit RUM version is set", () => {
    const { cwd } = makeBuildDir();
    const calls: { version: string }[] = [];

    // The other half of the same order. The child-env cases below set only
    // VERCEL_GIT_COMMIT_SHA, but they assert the child env and never the
    // version, so nothing there pins WHAT the fallback resolves to — an
    // uploaded map tagged with the wrong version symbolicates nothing, and it
    // would still look like a successful upload.
    finalizeBrowserSourceMaps(
      {
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        DD_API_KEY: "key-123",
        VERCEL_GIT_COMMIT_SHA: "sha-abc",
      },
      cwd,
      (version) => calls.push({ version })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].version).toBe("sha-abc");
  });

  it("refuses to ship on a Vercel build without deleting the map", () => {
    const { cwd, mapFile } = makeBuildDir();
    const runner = vi.fn();

    expect(() =>
      finalizeBrowserSourceMaps(
        {
          [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
          DD_API_KEY: "key-123",
          VERCEL: "1",
          VERCEL_GIT_COMMIT_SHA: "sha-abc",
        },
        cwd,
        runner
      )
    ).toThrow(REFUSING_TO_SHIP);

    // The map STAYING is the assertion, not a side note. On Vercel the copy
    // being served was taken before this code could run, so deleting removes
    // nothing that is reachable and reports success over a live disclosure —
    // which is exactly what happened. A change that re-adds a strip on this
    // path turns this line red.
    expect(existsSync(mapFile)).toBe(true);
    // And nothing is uploaded from a build whose maps must not exist at all.
    expect(runner).not.toHaveBeenCalled();
  });

  it("never throws for a TELEMETRY failure on an off-Vercel build", () => {
    const { cwd } = makeBuildDir();

    // A failed upload must not be able to fail a deploy. Narrowed twice, and
    // the name says which slice is left: from "never throws" (#5739 review),
    // because a map still in `.next/static` throws — a served source map is an
    // incident rather than a missing metric — and from "whatever the
    // environment" (ISS-8925), because a Vercel build refuses rather than
    // strips and so is covered by its own case above, not this one. Every
    // upload-side failure still returns quietly.
    expect(() =>
      finalizeBrowserSourceMaps({ [DD_SOURCEMAP_UPLOAD_FLAG]: "true" }, cwd)
    ).not.toThrow();
    expect(() =>
      finalizeBrowserSourceMaps(
        { [DD_SOURCEMAP_UPLOAD_FLAG]: "true" },
        "/does/not/exist"
      )
    ).not.toThrow();
  });

  it("refuses to ship when a source map survives the off-Vercel strip", () => {
    const { cwd, mapFile } = makeBuildDir();
    // The map cannot be removed, so it would be served under `.next/static`.
    // Simulated by making the file undeletable via its parent directory: the
    // real cause (a lock, a slow FS) does not matter, only that it survives.
    const staticChunks = path.dirname(mapFile);
    chmodSync(staticChunks, 0o500);

    try {
      expect(() =>
        finalizeBrowserSourceMaps({ [DD_SOURCEMAP_UPLOAD_FLAG]: "true" }, cwd)
      ).toThrow(
        new RegExp(
          `refusing to ship.*${path.basename(mapFile).replace(/\./g, "\\.")}`
        )
      );
      // The surviving map must still be on disk — it was undeletable.
      expect(existsSync(mapFile)).toBe(true);
    } finally {
      chmodSync(staticChunks, 0o700);
    }
  });

  it("never forwards a configured Datadog site to the child", () => {
    const { cwd } = makeBuildDir();
    const calls: { env: Record<string, string | undefined> }[] = [];

    finalizeBrowserSourceMaps(
      {
        DD_API_KEY: "key-123",
        DD_SITE: "datadoghq.com@attacker.example",
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        VERCEL_GIT_COMMIT_SHA: "sha-abc",
      },
      cwd,
      (_version, _dir, env) => calls.push({ env })
    );

    // The CLI interpolates the site into the request AUTHORITY, so this value
    // would resolve to `attacker.example` and ship the credential with it. The
    // site is not forwarded at all, so the hostile value cannot reach the child
    // even though the upload still runs against the default intake.
    expect(calls).toHaveLength(1);
    expect(calls[0].env.DD_SITE).toBeUndefined();
    expect(calls[0].env.DATADOG_SITE).toBeUndefined();
    expect(calls[0].env.DATADOG_API_KEY).toBe("key-123");
  });

  it("passes only the upload variables to the child, not the build env", () => {
    const { cwd } = makeBuildDir();
    const calls: { env: Record<string, string | undefined> }[] = [];

    finalizeBrowserSourceMaps(
      {
        AWS_SECRET_ACCESS_KEY: "must-not-travel",
        DATABASE_URL: "postgres://must-not-travel",
        DD_API_KEY: "key-123",
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        VERCEL_GIT_COMMIT_SHA: "sha-abc",
      },
      cwd,
      (_version, _dir, env) => calls.push({ env })
    );

    expect(calls).toHaveLength(1);
    // The credential still reaches the CLI...
    expect(calls[0].env.DATADOG_API_KEY).toBe("key-123");
    // ...and nothing else the build happened to hold does. Asserted by NAME on
    // the secrets, and by exhaustive key set so a newly-forwarded variable has
    // to be added here deliberately rather than leaking silently.
    expect(calls[0].env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(calls[0].env.DATABASE_URL).toBeUndefined();
    expect(Object.keys(calls[0].env).sort()).toEqual(["DATADOG_API_KEY"]);
  });

  it("renames DD_API_KEY to the DATADOG_API_KEY the CLI requires", () => {
    const { cwd } = makeBuildDir();
    const calls: { env: Record<string, string | undefined> }[] = [];

    finalizeBrowserSourceMaps(
      {
        DD_API_KEY: "key-123",
        [DD_SOURCEMAP_UPLOAD_FLAG]: "true",
        VERCEL_GIT_COMMIT_SHA: "sha-abc",
      },
      cwd,
      (_version, _dir, env) => calls.push({ env })
    );

    expect(calls).toHaveLength(1);
    // `datadog-ci` v5.22.1 reads the key for its metrics logger from
    // DATADOG_API_KEY ALONE. Handed only DD_API_KEY — the name this estate
    // actually sets on the Vercel projects — it aborts the whole command with
    // `Internal Error: DATADOG_API_KEY environment variable not set`. Passing
    // DD_API_KEY straight through would therefore upload nothing, on every
    // deploy; the rename is what makes the upload run at all.
    expect(calls[0].env.DATADOG_API_KEY).toBe("key-123");
    // And the estate's own spelling does NOT also travel: one name in the child
    // env, so there is no second copy of the credential to keep in sync.
    expect(calls[0].env.DD_API_KEY).toBeUndefined();
  });
});

/**
 * The production entrypoint, spawned as itself. Reached through the file rather
 * than an import because what is under test IS the wiring — the `exit` handler
 * calling the finalizer on a successful child, and the refusal propagating out
 * as a non-zero exit.
 */
const BUILD_ENTRYPOINT = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "build.mjs"
);

/** Bounds the child; a Vitest timeout cannot interrupt a wedged `spawnSync`. */
const BUILD_TIMEOUT_MS = 60_000;

/**
 * `next build --help` prints usage and exits 0 without building anything, which
 * is the successful-child branch for a tenth of a second and no project fixture.
 */
function runBuildEntrypoint(cwd: string) {
  // The Vercel branch: assert and return, so nothing strips the fixture map out
  // from under the assertion.
  const env = { ...process.env, VERCEL: "1" };

  // The `test` lane in pr-test.yml exports
  // `NODE_OPTIONS=... -r dd-trace/ci/init --import dd-trace/register.js`, and a
  // bare preload specifier resolves against the CHILD's cwd — which here is a
  // synthetic fixture tree with no `node_modules`. Inherited, it kills the child
  // at startup with MODULE_NOT_FOUND before `build.mjs` runs at all, so both
  // cases below fail on the runner and pass everywhere else. This process
  // already read its own NODE_OPTIONS at startup; removing it here reaches only
  // the children.
  Reflect.deleteProperty(env, "NODE_OPTIONS");

  return spawnSync(process.execPath, [BUILD_ENTRYPOINT, "--help"], {
    cwd,
    encoding: "utf-8",
    env,
    timeout: BUILD_TIMEOUT_MS,
  });
}

describe("build.mjs", () => {
  it("exits 0 through the real entrypoint when the served tree has no map", () => {
    const { cwd, mapFile } = makeBuildDir();
    rmSync(mapFile);

    // The control for the case below. Without it, a non-zero exit there could
    // just as well mean the child never succeeded, and the assertion would
    // prove nothing about finalization.
    expect(runBuildEntrypoint(cwd).status).toBe(0);
  });

  it("fails the build through the real entrypoint when a map is in the served tree", () => {
    const { cwd, mapFile } = makeBuildDir();

    // #6933 review: the refusal was only ever driven by calling
    // `finalizeBrowserSourceMaps()` directly, so deleting the call in
    // `build.mjs` — or catching the throw instead of letting it propagate —
    // left every one of those cases green while a successful `next build`
    // promoted a served map.
    const result = runBuildEntrypoint(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(REFUSING_TO_SHIP);
    expect(existsSync(mapFile)).toBe(true);
  });
});
