import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isProfilingRendererBuildEnabled,
  PROFILING_RENDERER_BUILD_ENABLED_VALUE,
  ProfilingEnvVar,
} from "../src/shared/profiling.js";

// ISS-5278 — the render-commit lane's real gate is a BUILD-time one.
//
// React ships `<Profiler onRender>` only in its development and profiling
// builds, so a renderer bundled against the stock production `react-dom` never
// invokes the callback `useRenderCommitInstrumentation` returns and
// `render-commits.jsonl` is never written. The fix is an opt-in alias to
// `react-dom/profiling` in `vite.renderer.config.ts`.
//
// The config reads its flag from `process.env` at MODULE LOAD, and node:test
// gives one process per test FILE, so a single file cannot import it twice under
// two different environments. Both branches are therefore exercised by loading
// the REAL config in a child process — which also makes these assertions about
// the shipped build config itself rather than about a re-implementation of it.

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const RENDER_DOM_PROFILING_ENTRY = "react-dom/profiling";

/** Framing so the payload survives any build chatter the child writes first. */
const ALIAS_PAYLOAD_MARKER = "<<ALIAS>>";

/** Parses a serialized RegExp (`String(/x/i)`) back into source + flags. */
const REGEX_LITERAL_PATTERN = /^\/(?<source>.*)\/(?<flags>[a-z]*)$/;

/** Alias entries as the child can serialize them (a RegExp is not JSON). */
type SerializedAlias = { find: string; replacement: string };

/**
 * Load `vite.renderer.config.ts` in a child process under `env` and return its
 * resolved alias list.
 *
 * `spawnSync` on purpose: it cannot leave a stranded child or hang the suite the
 * way an unhandled `error` event on an async spawn would, and it surfaces a
 * launch failure as `result.error` rather than a silent empty result.
 *
 * Failures THROW rather than assert: an assertion here would sit outside a
 * `test()` (Biome's `noMisplacedAssertion`), and a throw from a helper fails the
 * calling test just as loudly.
 */
function loadRendererAliases(env: NodeJS.ProcessEnv): SerializedAlias[] {
  // No top-level await: `tsx -e` compiles the snippet to CJS, which rejects it.
  const script = `
    import("./vite.renderer.config.ts").then((mod) => {
      const alias = mod.default.resolve.alias;
      process.stdout.write(
        ${JSON.stringify(ALIAS_PAYLOAD_MARKER)} +
          JSON.stringify(
            alias.map((entry) => ({
              find: String(entry.find),
              replacement: String(entry.replacement),
            }))
          )
      );
    }).catch((error) => {
      process.stderr.write(String(error && error.stack ? error.stack : error));
      process.exit(1);
    });
  `;

  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "tsx", "-e", script],
    {
      cwd: desktopDir,
      encoding: "utf8",
      env,
      timeout: 120_000,
    }
  );

  if (result.error) {
    throw new Error(
      `loading vite.renderer.config.ts failed to spawn: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `loading vite.renderer.config.ts exited ${result.status}: ${result.stderr}`
    );
  }

  const marker = result.stdout.lastIndexOf(ALIAS_PAYLOAD_MARKER);
  if (marker === -1) {
    throw new Error(
      `child produced no alias payload. stdout: ${result.stdout} stderr: ${result.stderr}`
    );
  }
  return JSON.parse(result.stdout.slice(marker + ALIAS_PAYLOAD_MARKER.length));
}

function envWithout(key: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  Reflect.deleteProperty(env, key);
  return env;
}

/** The workspace aliases that must survive the object→array conversion. */
const REQUIRED_WORKSPACE_ALIASES = [
  "@",
  "@repo/api",
  "@repo/app",
  "@repo/lib",
  "@closedloop-ai/design-system",
];

describe("isProfilingRendererBuildEnabled", () => {
  test("is enabled only by the exact opt-in value", () => {
    assert.equal(
      isProfilingRendererBuildEnabled({
        [ProfilingEnvVar.RendererBuild]: PROFILING_RENDERER_BUILD_ENABLED_VALUE,
      }),
      true
    );
    assert.equal(isProfilingRendererBuildEnabled({}), false);
    assert.equal(
      isProfilingRendererBuildEnabled({
        [ProfilingEnvVar.RendererBuild]: "0",
      }),
      false
    );
    assert.equal(
      isProfilingRendererBuildEnabled({
        [ProfilingEnvVar.RendererBuild]: "true",
      }),
      false
    );
  });

  test("does not require the profile run directory", () => {
    // The trap this guards: every OTHER predicate in profiling.ts is gated on
    // `ProfilingEnvVar.Dir`, but the run directory does not exist yet at BUILD
    // time. Gating this one the same way would make the flag unsatisfiable and
    // silently hand back a stock production renderer — the original bug.
    assert.equal(
      isProfilingRendererBuildEnabled({
        [ProfilingEnvVar.RendererBuild]: PROFILING_RENDERER_BUILD_ENABLED_VALUE,
      }),
      true
    );
  });
});

describe("vite.renderer.config.ts react-dom aliasing", () => {
  test("aliases react-dom/client — and ONLY it — to the profiling build when opted in", () => {
    // Aliasing the ROOT `react-dom` specifier as well is a crash, not a
    // belt-and-braces improvement: `react-dom/profiling` does
    // `require("react-dom")` for the shared
    // `__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` module, so
    // redirecting the root points that dependency at the profiling bundle
    // itself. The cycle leaves the internals undefined and the renderer throws
    // `Cannot read properties of undefined (reading 'd')` before React mounts —
    // and a build/serve is the only thing that surfaces it, so pin the exact
    // entry list here.
    const aliases = loadRendererAliases({
      ...process.env,
      [ProfilingEnvVar.RendererBuild]: PROFILING_RENDERER_BUILD_ENABLED_VALUE,
    });

    const reactDomAliases = aliases.filter((entry) =>
      entry.replacement.includes(RENDER_DOM_PROFILING_ENTRY)
    );
    assert.deepEqual(
      reactDomAliases.map((entry) => entry.find),
      ["/^react-dom\\/client$/"]
    );
    assert.equal(
      reactDomAliases[0].replacement,
      RENDER_DOM_PROFILING_ENTRY,
      "react-dom/client must resolve to the profiling reconciler"
    );
  });

  test("adds no react-dom alias when the flag is unset — production builds are untouched", () => {
    const aliases = loadRendererAliases(
      envWithout(ProfilingEnvVar.RendererBuild)
    );

    const reactDomAliases = aliases.filter(
      (entry) =>
        entry.find.includes("react-dom") ||
        entry.replacement.includes("react-dom")
    );
    assert.deepEqual(
      reactDomAliases,
      [],
      "a shipping renderer must never be built against react-dom/profiling"
    );
  });

  test("keeps every workspace alias in both modes", () => {
    // The react-dom entries forced `resolve.alias` from an object map to the
    // array form. A dropped workspace alias would not fail the build loudly —
    // Rollup silently externalizes the bare specifier and the renderer throws at
    // runtime when the chunk loads — so assert they all survived.
    for (const env of [
      {
        ...process.env,
        [ProfilingEnvVar.RendererBuild]: PROFILING_RENDERER_BUILD_ENABLED_VALUE,
      },
      envWithout(ProfilingEnvVar.RendererBuild),
    ]) {
      const finds = loadRendererAliases(env).map((entry) => entry.find);
      for (const expected of REQUIRED_WORKSPACE_ALIASES) {
        assert.ok(
          finds.includes(expected),
          `workspace alias ${expected} missing from resolve.alias`
        );
      }
    }
  });

  test("the react-dom pattern is anchored so sibling subpaths still resolve", () => {
    // Vite/Rollup treat a STRING `find` as a prefix (`id === find ||
    // id.startsWith(find + "/")`), so a bare "react-dom" entry would also
    // capture `react-dom/server` — which this renderer graph imports — and
    // rewrite it to the nonexistent `react-dom/profiling/server`. Rebuild the
    // pattern the config actually shipped and prove it does not.
    const aliases = loadRendererAliases({
      ...process.env,
      [ProfilingEnvVar.RendererBuild]: PROFILING_RENDERER_BUILD_ENABLED_VALUE,
    });
    const patterns = aliases
      .filter((entry) => entry.replacement === RENDER_DOM_PROFILING_ENTRY)
      .map((entry) => {
        const match = REGEX_LITERAL_PATTERN.exec(entry.find);
        assert.ok(
          match?.groups,
          `alias find is not a regex literal: ${entry.find}`
        );
        return new RegExp(match.groups.source, match.groups.flags);
      });
    assert.equal(patterns.length, 1);

    const matches = (specifier: string) =>
      patterns.some((pattern) => pattern.test(specifier));

    assert.equal(matches("react-dom/client"), true);
    // The root specifier and `profiling` itself must pass through untouched, or
    // the profiling bundle's own `require("react-dom")` resolves to itself.
    assert.equal(matches("react-dom"), false);
    assert.equal(matches("react-dom/profiling"), false);
    assert.equal(matches("react-dom/server"), false);
    assert.equal(matches("react-dom/server.browser"), false);
    assert.equal(matches("react-dom/test-utils"), false);
  });
});
