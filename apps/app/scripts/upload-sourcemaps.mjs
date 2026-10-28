import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * ISS-7766: ship browser source maps to Datadog. ISS-8925: never from a build
 * whose output the platform publishes.
 *
 * Two invariants, in this order of importance:
 *
 * 1. NEVER fail the build FOR A TELEMETRY FAILURE. An upload is not worth a
 *    failed deploy; every upload failure path here logs and returns. This
 *    mirrors the repo's build/test decoupling (FEA-1523) — observability
 *    plumbing must not be able to error a deploy.
 * 2. NEVER SHIP a `.map` in `.next/static`. That tree is what `/_next/static/*`
 *    serves, so a map left in it publishes readable first-party source for the
 *    whole app.
 *
 * Invariant 2 OUTRANKS invariant 1 (#5739 review): a 200 on a served map is an
 * incident, categorically worse than a missing deploy, so it THROWS and fails
 * the build while every telemetry failure still returns quietly.
 *
 * ISS-8925 changed HOW invariant 2 is kept, because the first shape of it lost.
 * It used to be "always strip the maps afterwards, then verify the strip" — and
 * that check passed, reporting 299 files removed from a directory it confirmed
 * empty, while those 299 maps were being served on `app.closedloop.ai` with
 * `sourcesContent`. Vercel had already copied `.next/static` into what it
 * serves; the delete was real, verified, and aimed at a directory that no longer
 * decided anything. Nor could it be undone afterwards — the copies are served
 * `immutable` with a one-year max-age and survived a redeploy from a map-free
 * build, `edge-cache/purge-all`, deleting the deployments, and
 * `vercel cache purge --type cdn`.
 *
 * So deleting is not a remedy here and its success is not evidence. Two things
 * replace it, and neither is a delete:
 *
 * - The emit is refused on Vercel at all (`shouldEmitBrowserSourceMaps`), so
 *   there is nothing to race.
 * - {@link assertNoPublishedSourceMaps} asks the tree, not the deletion,
 *   whether a map is there — on every build, whatever the flag says, and
 *   without touching a file. Refusing still works where deleting does not: the
 *   copy Vercel took is out of reach, but a build that exits non-zero is never
 *   promoted, so nothing it produced is ever served.
 */

/**
 * A stuck `datadog-ci` would otherwise hold the finished build open until Vercel
 * kills the whole job, turning a telemetry problem into a failed deploy — the
 * exact outcome invariant 1 exists to prevent. Generous enough for a cold upload
 * of a large bundle, far short of any platform build ceiling.
 */
const UPLOAD_TIMEOUT_MS = 120_000;

const SERVICE = "cl-app";
/** The intake `datadog-ci` uses when no site is in its environment. */
const DEFAULT_DATADOG_SITE = "datadoghq.com";
// Path-only, so one upload is valid for every host the bundle is served from
// (prod domain, stage, and every preview URL) rather than being pinned to one.
const MINIFIED_PATH_PREFIX = "/_next/static";

function log(message) {
  process.stdout.write(`[datadog-sourcemaps] ${message}\n`);
}

/**
 * The version RUM tags events with — the join key Datadog symbolicates on.
 *
 * `resolveDatadogRumBuildVersion` (the client-side half) prefers
 * `VERCEL_GIT_COMMIT_SHA` when `VERCEL` is set, and this deliberately no longer
 * mirrors that branch: since ISS-8925 no upload runs on Vercel at all, so the
 * branch could never be taken from here. Do not restore it to "keep them in
 * sync" — an upload reachable on Vercel is the defect. An off-Vercel job
 * symbolicating a Vercel-built bundle has to carry that build's sha in one of
 * these two variables itself.
 */
function resolveReleaseVersion(env) {
  return env.NEXT_PUBLIC_DATADOG_RUM_VERSION ?? env.VERCEL_GIT_COMMIT_SHA;
}

function collectSourceMaps(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceMaps(full));
    } else if (entry.endsWith(".map")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Deletes every `.map` under `.next/static`, retrying once.
 *
 * Only ever runs where this build's `.next/static` is still the tree that
 * decides what ships — never on Vercel, where it deletes a copy nobody serves.
 *
 * It reports what it ATTEMPTED and returns no verdict: whether the tree is now
 * clean is {@link assertNoPublishedSourceMaps}'s question, asked of the tree
 * afterwards. The line this used to log — `stripped N .map file(s)` — is the
 * one that read as an all-clear over a live disclosure, so it no longer claims
 * an outcome it cannot see.
 */
function stripSourceMaps(staticDir) {
  for (const attempt of [1, 2]) {
    const maps = collectSourceMaps(staticDir);
    if (maps.length === 0) {
      return;
    }
    let deleted = 0;
    for (const file of maps) {
      try {
        rmSync(file, { force: true });
        deleted += 1;
      } catch (error) {
        log(`could not delete ${file} (attempt ${attempt}): ${error}`);
      }
    }
    log(
      `attempt ${attempt}: deleted ${deleted} of ${maps.length} .map file(s) from .next/static`
    );
  }
}

function resolveDatadogCli() {
  // Resolved, never hardcoded: pnpm stores the real file under `.pnpm/`, and
  // the package's `exports` map refuses a direct `dist/` subpath.
  const require = createRequire(import.meta.url);
  return require.resolve("@datadog/datadog-ci");
}

/**
 * The ONLY variables the child receives (#5739 review). The `env` handed in is
 * the whole build environment, and passing that to a third-party CLI passes it
 * every secret the build holds. `datadog-ci` needs the credential, the intake
 * site, and enough of a shell to run — so nothing else is forwarded.
 *
 * `PATH`/`HOME` are carried because a child spawned with neither cannot reliably
 * resolve a temp dir or a CA bundle; neither is a secret.
 *
 * `DD_SITE` is deliberately NOT forwarded (#5739 review). The CLI interpolates
 * the site into the request AUTHORITY, so a hostile value like
 * `datadoghq.com@attacker.example` resolves to the attacker and ships the API
 * key with it. Every other Datadog sender in this repo defends that with the
 * exact-membership `isAllowedDatadogSite` allowlist (ISS-5261), but that lives
 * in TypeScript and this script runs under plain `node` during the build —
 * importing the built `dist` would make a TEST depend on a package build that
 * `turbo`'s `test` task does not order (`dependsOn: ["^test"]`), and nothing
 * else in the repo imports a `@repo/*` package from a `.mjs`.
 *
 * Not forwarding it closes the same hole without the coupling: with no site in
 * the child env the CLI uses its own default, which is the US1 intake this repo
 * defaults to anyway. A site OTHER than that default is logged when withheld,
 * so a real divergence is never silent. Routing a non-default site here is a
 * deliberate follow-up that should go through the canonical allowlist from a
 * TypeScript surface.
 *
 * ISS-7766: the credential goes in under the CLI's OWN spelling. This repo names
 * every Datadog variable `DD_*`, but `datadog-ci` reads the key for its metrics
 * logger from `DATADOG_API_KEY` alone — handed only `DD_API_KEY` it aborts the
 * whole command with `Internal Error: DATADOG_API_KEY environment variable not
 * set`, verified against v5.22.1. So the translation happens HERE, at the one
 * boundary that needs it, rather than by carrying a second name for the same
 * secret through the deploy environment.
 */
function narrowUploadEnv(env) {
  const child = Object.create(null);
  if (env.DD_API_KEY !== undefined) {
    child.DATADOG_API_KEY = env.DD_API_KEY;
  }
  for (const key of ["PATH", "HOME"]) {
    if (env[key] !== undefined) {
      child[key] = env[key];
    }
  }
  return child;
}

/**
 * Spawns the CLI with EXACTLY the env it is handed. The site check and the env
 * narrowing both live in {@link attemptUpload} rather than here (#5739
 * review): they are decisions about whether and with what to upload, they sit
 * beside the API-key gate that shares their shape, and — the reason that
 * settled it — anything below the injectable `runner` seam is both bypassable
 * and untestable.
 */
function runUpload(releaseVersion, staticDir, env) {
  const result = spawnSync(
    process.execPath,
    [
      resolveDatadogCli(),
      "sourcemaps",
      "upload",
      staticDir,
      `--service=${SERVICE}`,
      `--release-version=${releaseVersion}`,
      `--minified-path-prefix=${MINIFIED_PATH_PREFIX}`,
    ],
    {
      env,
      killSignal: "SIGKILL",
      stdio: ["ignore", "inherit", "inherit"],
      timeout: UPLOAD_TIMEOUT_MS,
    }
  );

  if (result.error) {
    // A timeout kill surfaces as an ETIMEDOUT error here, so this branch covers
    // both "could not start" and "ran past the deadline".
    log(`upload could not start or timed out: ${result.error}`);
    return;
  }
  if (result.signal) {
    log(
      `upload killed by ${result.signal}; continuing without failing the build`
    );
    return;
  }
  if (result.status !== 0) {
    log(`upload exited ${result.status}; continuing without failing the build`);
    return;
  }
  log(`uploaded source maps for ${SERVICE} @ ${releaseVersion}`);
}

/**
 * One upload attempt. Split out of {@link finalizeBrowserSourceMaps} so its
 * several "skip and log" exits are returns from THIS function rather than from
 * the caller — which lets the strip and the ship-refusal below it live in
 * normal control flow instead of a `finally`, where a `throw` would overwrite
 * whatever the `try` was doing (`noUnsafeFinally`).
 */
function attemptUpload(env, staticDir, runner) {
  if (!env.DD_API_KEY) {
    // The flag was deliberately set, so silence here would look like success.
    log(
      "DD_SOURCEMAP_UPLOAD=true but DD_API_KEY is unset — skipping upload. RUM stacks stay minified."
    );
    return;
  }

  const releaseVersion = resolveReleaseVersion(env);
  if (!releaseVersion) {
    log(
      "no release version (VERCEL_GIT_COMMIT_SHA / NEXT_PUBLIC_DATADOG_RUM_VERSION) — skipping upload. An upload tagged `unknown` could not be joined to RUM events anyway."
    );
    return;
  }

  // Only a site that DIVERGES from the intake the CLI would pick anyway is
  // worth a line. ISS-7766 puts `DD_SITE` in this build environment on every
  // deploy, and it holds the default — warning unconditionally would print a
  // "your setting is being ignored" line on every single build for a setting
  // that changes nothing, which is how a real divergence gets tuned out.
  if (env.DD_SITE && env.DD_SITE !== DEFAULT_DATADOG_SITE) {
    log(
      `DD_SITE ("${env.DD_SITE}") is not forwarded to the CLI — uploading to ${DEFAULT_DATADOG_SITE} instead. See narrowUploadEnv.`
    );
  }

  const maps = collectSourceMaps(staticDir);
  if (maps.length === 0) {
    log(
      "no .map files in .next/static — did productionBrowserSourceMaps stay off? skipping upload."
    );
    return;
  }

  // The runner receives the NARROWED env, never the build environment. That
  // makes the child's exact inheritance the runner's documented contract, and
  // observable from a test without spawning anything.
  runner(releaseVersion, staticDir, narrowUploadEnv(env));
}

/**
 * Fails the build when a `.map` is in `.next/static`, whoever put it there.
 *
 * This asks the question the previous guard did not (ISS-8925). That one asked
 * "did the files I emitted get deleted", answered yes, and was right — about a
 * directory that had already been copied into what Vercel serves. Disclosure
 * turns on whether a map is IN the served tree, not on whose delete succeeded,
 * so this reads the tree and nothing else: it never deletes, so its verdict
 * cannot be manufactured by the deletion it is checking, and it never reads
 * `DD_SOURCEMAP_UPLOAD`, so a map that arrived by some other route — a config
 * change, a dependency, a restored build cache — is the same incident and gets
 * the same refusal.
 *
 * Named individually so the build log says exactly what would have shipped.
 */
function assertNoPublishedSourceMaps(staticDir) {
  const maps = collectSourceMaps(staticDir);
  if (maps.length > 0) {
    throw new Error(
      `refusing to ship: ${maps.length} source map(s) are in .next/static and would be served publicly: ${maps.join(", ")}`
    );
  }
}

/**
 * The whole post-build source-map step: upload where that is safe, and refuse
 * to ship a map wherever one is found. Called once, from `build.mjs`, after a
 * successful `next build`.
 *
 * `runner` is injectable so tests can drive the failure paths without a real
 * network call; production always uses the spawning default.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 * @param {(releaseVersion: string, staticDir: string, env: Record<string, string | undefined>) => void} [runner]
 * @returns {void}
 */
export function finalizeBrowserSourceMaps(
  env = process.env,
  cwd = process.cwd(),
  runner = runUpload
) {
  const staticDir = path.join(cwd, ".next", "static");

  // On Vercel the only move left is refusing. Uploading would need maps that
  // `shouldEmitBrowserSourceMaps` no longer emits here, and deleting is the
  // move that produced a verified all-clear over a live disclosure — by the
  // time anything here runs, the copy being served has been taken.
  //
  // This read is load-bearing: false here on a build that IS published sends
  // the tree down the strip path, which cannot protect it. `VERCEL` is Vercel's
  // own system variable, set on every build it runs, and it is already what
  // `resolveDatadogRumBuildVersion` and the rest of this estate branch on — so
  // it is the right discriminator, not merely the convenient one. A second
  // platform that publishes a build output belongs in this condition, not in a
  // pre-strip check that would fire on the very maps the off-Vercel flow exists
  // to upload (verified: doing that reds 9 of 13 cases in this file's suite).
  if (env.VERCEL) {
    assertNoPublishedSourceMaps(staticDir);
    return;
  }

  if (env.DD_SOURCEMAP_UPLOAD === "true") {
    try {
      attemptUpload(env, staticDir, runner);
    } catch (error) {
      log(`unexpected failure, continuing: ${error}`);
    }

    // Reached on EVERY path above — skip, success, or swallowed failure —
    // because the attempt's early exits return from `attemptUpload`.
    stripSourceMaps(staticDir);
  }

  assertNoPublishedSourceMaps(staticDir);
}
