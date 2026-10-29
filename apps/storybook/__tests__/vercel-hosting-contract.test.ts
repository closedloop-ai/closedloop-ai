/**
 * ISS-9687 / ISS-10261 — how this Storybook reaches a real URL.
 *
 * One hosting path: nested inside `apps/prototypes`' own deployment,
 * published at `/storybook/`. Operator ruling, 2026-09-07 (Marisol Ashgrove):
 * the cost of an N+1 Vercel project is not worth paying. See
 * `docs/design/storybook-governance.md` § Hosting for the full record.
 *
 * A standalone Vercel project (`closedloop-ai-storybook`) briefly existed
 * as a second path (PLN-2024 Phase A.3) — Marisol closed that PR directly on
 * the same objection ("No we do NOT want another Vercel project"), it was
 * re-added anyway on a later branch, and only its Basic Auth gate got
 * removed (ISS-10261) rather than the project itself. Reaffirmed and
 * reverted 2026-09-18 (Mordecai: "we don't want a second vercel. marisol is
 * right.") — `vercel.json` is back to the one key every sibling app
 * carries, and this file goes back to asserting that key's absence rather
 * than a standalone project's config, which is what it asserted before
 * Phase A.3 ever shipped. The standalone Vercel project itself (the live
 * deployment, not just this repo's config for it) still needs decommissioning
 * on Vercel's side by whoever has access — that's outside what a git commit
 * can do.
 *
 * ISS-10991: the prototypes build COPIES `storybook#build`'s output into
 * `public/storybook` instead of running a second full Storybook build there, so
 * a deploy that misses the turbo cache pays for one Vite build, not two.
 *
 * Every expectation below is an independently written literal, or derived from
 * the Storybook config the build actually runs. Nothing reads its expected
 * value out of the file it polices.
 *
 * WHAT THIS SUITE DOES NOT COVER (@davetho): it never boots `next` and never
 * requests `/storybook` over HTTP. The redirect case executes the real
 * `next.config.ts`, so swapping the redirect for a rewrite or moving its
 * destination reddens here — but Next's own verbatim `public/` subpath serving
 * is taken on trust. Proving this end to end needs a `next build` + `next
 * start` browser lane of its own, the `web-boot-smoke` shape in pr-test.yml.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTurboConfig as readTurboConfigFile } from "../../../scripts/lint/read-turbo-config";
import prototypesNextConfig from "../../prototypes/next.config";
import { storybookModuleAliases } from "../.storybook/module-aliases";
import {
  STORYBOOK_DIR,
  storybookConfigReadPaths,
  storybookStoryPatterns,
} from "./helpers/storybook-config-source";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "../..");
const PROTOTYPES_ROOT = path.join(REPO_ROOT, "apps/prototypes");

/** Where the hosting deployment serves the build from, relative to its app. */
const HOSTED_OUTPUT_DIR = "public/storybook";
/** Resolved by Vercel relative to the project's Root Directory. */
const EXPECTED_IGNORE_COMMAND = "node scripts/skip-ci.js";
/** What `storybook#build` writes, and so what a cache hit restores. */
const STORYBOOK_BUILD_OUTPUT = "storybook-static/**";
const HOSTED_COPY_INVOCATION = "node scripts/copy-hosted-storybook.mjs";
const STORYBOOK_BUILD_COMMAND = "storybook build";
const STORYBOOK_PACKAGE_FILTER = "--filter storybook";
const NEXT_BUILD = "next build";
/** The URL the team is handed, and the file `public/` actually serves for it. */
const HOSTED_ENTRY_PATH = "/storybook";
const HOSTED_INDEX_PATH = "/storybook/index.html";
/**
 * The owning source boundary of the desktop stories Storybook indexes by glob —
 * not the glob root, which their imports already escape.
 */
const DESKTOP_SOURCE_INPUT = "$TURBO_ROOT$/apps/desktop/src/**";
/**
 * `apps/app` is not a package dependency of this app, yet the build reads it:
 * the `@` alias the Surface stories import through, a `staticDirs` mount, and
 * the `@posthog/next` alias target all live there.
 */
const APP_SOURCE_INPUT = "$TURBO_ROOT$/apps/app/**";
const TURBO_ROOT = "$TURBO_ROOT$/";
const RECURSIVE_GLOB = "/**";
/** The first path segment that is a glob, not a directory. */
const GLOB_SEGMENT = /[*?{[(!@]/;

type VercelConfig = {
  framework?: string | null;
  ignoreCommand?: string;
  outputDirectory?: string;
  installCommand?: string;
  buildCommand?: string;
};

type PackageJson = { scripts?: Record<string, string> };

type TurboConfig = {
  tasks?: Record<
    string,
    { dependsOn?: string[]; inputs?: string[]; outputs?: string[] }
  >;
};

describe("hosted Storybook wiring", () => {
  it("carries no standalone-project config — that path is decommissioned", () => {
    const config = readVercelConfig(APP_ROOT);

    // `framework` and `outputDirectory` are only meaningful to a Vercel
    // project whose Root Directory is this app. There is no such project any
    // more (reverted 2026-09-18, see the header comment) — either key
    // reappearing is how this repo quietly re-acquires the N+1 project the
    // 2026-09-07 ruling rejected, so their ABSENCE is the thing this test
    // pins, not their value.
    expect(config.framework).toBeUndefined();
    expect(config.outputDirectory).toBeUndefined();
    expect(config.installCommand).toBeUndefined();
    expect(config.buildCommand).toBeUndefined();
  });

  it("keeps the one key its siblings do share", () => {
    expect(readVercelConfig(APP_ROOT).ignoreCommand).toBe(
      EXPECTED_IGNORE_COMMAND
    );
    expect(readVercelConfig(PROTOTYPES_ROOT).ignoreCommand).toBe(
      EXPECTED_IGNORE_COMMAND
    );
  });

  it("has the prototypes build copy it in before next build collects public/", () => {
    const build = readPackageJson(PROTOTYPES_ROOT).scripts?.build ?? "";

    expect(build).toContain(HOSTED_COPY_INVOCATION);
    // Ordering is the contract, not mere presence: `next build` snapshots
    // `public/` as it finds it.
    expect(build.indexOf(HOSTED_COPY_INVOCATION)).toBeLessThan(
      build.indexOf(NEXT_BUILD)
    );
  });

  it("runs Storybook once per deploy — prototypes copies, it does not build", () => {
    // ISS-10991: a second build here doubled the Vite/Rolldown render step that
    // stalls and OOMs the 8 GB build container. `storybook#build` is the one
    // build; calling Storybook's CLI, or any script in its package, from here
    // is a second one.
    const build = readPackageJson(PROTOTYPES_ROOT).scripts?.build ?? "";

    expect(build).not.toContain(STORYBOOK_BUILD_COMMAND);
    expect(build).not.toContain(STORYBOOK_PACKAGE_FILTER);
  });

  it("caches what the copy reads, so a storybook#build cache hit restores it", () => {
    expect(readTurboConfig().tasks?.["storybook#build"]?.outputs).toContain(
      STORYBOOK_BUILD_OUTPUT
    );
  });

  it("caches the hosted output alongside the Next build", () => {
    const task = readTurboConfig().tasks?.["prototypes#build"];

    // A cache hit that restored `.next/` but not this would publish a
    // deployment with no Storybook in it at all.
    expect(task?.outputs).toContain(`${HOSTED_OUTPUT_DIR}/**`);
  });

  it("brings this app's own source into the prototypes build hash", () => {
    // Turbo hashes a task's dependency packages, and this app is not one of
    // prototypes' dependencies. Naming the task is what puts `apps/storybook`
    // in the hash, and it orders the copy after the build that writes
    // `storybook-static`. Without it an unfiltered `turbo build` could also
    // run the copy while `storybook#build` is still rewriting that directory.
    expect(readTurboConfig().tasks?.["prototypes#build"]?.dependsOn).toContain(
      "storybook#build"
    );
  });

  it("hashes what the Storybook build reads outside its own package", () => {
    // The hash that decides whether `storybook-static` is rebuilt or restored
    // is `storybook#build`'s own, and prototypes now serves that directory
    // verbatim. Each of these is read by the build but reached by no package
    // dependency, so leaving one out restores a stale Storybook on a cache hit.
    //
    // Desktop-renderer stories are indexed by glob, not by dependency.
    //
    // The whole `src/` boundary, NOT the `components/**` glob root, because
    // what the build compiles is each story's import closure and that already
    // escapes the root — `update-banner.stories.tsx` reads
    // `src/shared/packaged-update-install-blocked-reason.ts`. Gated on the glob
    // root alone, a change to one of those modules leaves every hash unchanged
    // and Turbo restores a stale `public/storybook`. Same owning source
    // boundary the `storybook` filter in pr-test.yml uses, for the same reason.
    expect(readTurboConfig().tasks?.["storybook#build"]?.inputs).toEqual(
      expect.arrayContaining([DESKTOP_SOURCE_INPUT, APP_SOURCE_INPUT])
    );
  });

  it("hashes every alias target, static dir and story root the build reads", () => {
    // Derived from the config the build runs, not hand-listed (tamsinb on
    // #7828): the `@repo` catch-all sends ANY `@repo/*` import to `packages/`,
    // so `prd-detail.stories.tsx` reached `@repo/analytics/client` and the
    // apps/app closure `@repo/auth/client` with neither in the hash, and an
    // edit to either restored a stale Storybook on a cache hit. A root is
    // hashed when it is this package's own or under a `$TURBO_ROOT$` input.
    const hashed = (readTurboConfig().tasks?.["storybook#build"]?.inputs ?? [])
      .filter(
        (input) =>
          input.startsWith(TURBO_ROOT) && input.endsWith(RECURSIVE_GLOB)
      )
      .map((input) => input.slice(TURBO_ROOT.length, -RECURSIVE_GLOB.length));
    const read = [
      ...Object.values(storybookModuleAliases(REPO_ROOT)),
      ...storybookConfigReadPaths(),
      ...storybookStoryPatterns().map((pattern) =>
        globBase(path.resolve(STORYBOOK_DIR, pattern))
      ),
    ].map((absolute) => path.relative(REPO_ROOT, absolute));

    // One root per channel, so a reader that silently found nothing cannot
    // make the check below vacuous.
    expect(read).toEqual(
      expect.arrayContaining([
        "packages",
        "apps/app/vitest-mocks/posthog-next.tsx",
        "apps/app/public",
        "apps/desktop/src/renderer/components",
      ])
    );
    const covered = [path.relative(REPO_ROOT, APP_ROOT), ...hashed];
    expect(
      read.filter((root) => !covered.some((dir) => isWithin(root, dir)))
    ).toEqual([]);
  });

  it("routes the hosted entry path by redirect, not rewrite", async () => {
    // Executed against the real config object Next loads, not read as text.
    // Storybook's manager references every asset relatively, so a rewrite —
    // which leaves the browser's base URL at `/storybook` — serves the manager
    // HTML with a 200 and then never boots it.
    const redirects = (await prototypesNextConfig.redirects?.()) ?? [];

    expect(
      redirects.find((entry) => entry.source === HOSTED_ENTRY_PATH)
    ).toEqual({
      destination: HOSTED_INDEX_PATH,
      permanent: false,
      source: HOSTED_ENTRY_PATH,
    });
    expect(prototypesNextConfig.rewrites).toBeUndefined();
  });

  it("keeps the generated build untracked", () => {
    const ignored = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());

    // `storybook-static/` elsewhere in the file does not match this path.
    expect(ignored).toContain(`/apps/prototypes/${HOSTED_OUTPUT_DIR}/`);
  });
});

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readVercelConfig(appRoot: string): VercelConfig {
  return readJson<VercelConfig>(path.join(appRoot, "vercel.json"));
}

function readPackageJson(appRoot: string): PackageJson {
  return readJson<PackageJson>(path.join(appRoot, "package.json"));
}

function readTurboConfig(): TurboConfig {
  return readTurboConfigFile<TurboConfig>(path.join(REPO_ROOT, "turbo.json"));
}

function isWithin(root: string, dir: string): boolean {
  return root === dir || root.startsWith(`${dir}/`);
}

/** The directory part of a glob: every segment before the first wildcard. */
function globBase(pattern: string): string {
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  return firstGlob === -1 ? pattern : segments.slice(0, firstGlob).join("/");
}
