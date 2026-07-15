import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  DESKTOP_RUNTIME_CLOSURE,
  isWorkspaceProtocolSpec,
  resolveStagedPackageRuntimeFile,
  resolveWorkspaceDependencyTarget,
} from "../scripts/packaging-workspace-deps.mjs";

const STAGE_PACKAGING_SCRIPT = "scripts/stage-packaging-app.mjs";

const CLOSURE_SSOT_IMPORT_PATTERN = /DESKTOP_RUNTIME_CLOSURE/;
// An inline `workspaceDependencyPackages = new Map([` literal would mean the
// closure is hand-maintained instead of derived from the SSOT.
const INLINE_MAP_LITERAL_PATTERN =
  /workspaceDependencyPackages = new Map\(\s*\[/;
const SQLITE_DERIVATION_SOURCE_IMPORT =
  /@repo\/api\/src\/session-trace\/derivation/;
const API_DIST_REACH_IN = /@repo\/api\/dist\//;
const TELEMETRY_CONTRACT_ATTRIBUTE_IMPORT =
  /@closedloop-ai\/telemetry-contract\/attributes/;

function closureDirFor(packageName: string): string | undefined {
  return DESKTOP_RUNTIME_CLOSURE.find(
    (entry) => entry.packageName === packageName
  )?.packageDir;
}

describe("packaging workspace dependencies", () => {
  test("derives workspaceDependencyPackages from the DESKTOP_RUNTIME_CLOSURE SSOT", () => {
    // The closure must not be hand-maintained in two places: the stager has to
    // build workspaceDependencyPackages from the shared constant so the post-merge
    // validation path filter (asserted in the workflow test) stays in lockstep
    // with the real packed closure (PRD-470 Q-004).
    const source = fs.readFileSync(STAGE_PACKAGING_SCRIPT, "utf8");

    assert.match(source, CLOSURE_SSOT_IMPORT_PATTERN);
    assert.doesNotMatch(
      source,
      INLINE_MAP_LITERAL_PATTERN,
      "workspaceDependencyPackages should be built from DESKTOP_RUNTIME_CLOSURE, not an inline Map literal"
    );
  });

  test("does not stage @repo/api — it is bundled into the main process", () => {
    // electron-vite inlines @repo/api from source (PLN-999), so it is not a
    // packed runtime closure member, and main imports its helpers from source
    // with no `dist`/`.js` reach-in. The session-trace builders that own this
    // import were extracted out of sqlite.ts into session-trace.ts (sqlite.ts
    // decomposition), so the source import now lives there.
    const sessionTraceSource = fs.readFileSync(
      "src/main/database/session-trace.ts",
      "utf8"
    );

    assert.equal(closureDirFor("@repo/api"), undefined);
    assert.match(sessionTraceSource, SQLITE_DERIVATION_SOURCE_IMPORT);
    assert.doesNotMatch(sessionTraceSource, API_DIST_REACH_IN);
  });

  test("resolveStagedPackageRuntimeFile resolves a runtime file path relative to a staged package root", () => {
    const stageAppDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-stage-api-")
    );
    try {
      const helperPath = path.join(
        stageAppDir,
        "node_modules",
        "@repo",
        "api",
        "dist",
        "session-trace",
        "derivation.js"
      );
      fs.mkdirSync(path.dirname(helperPath), { recursive: true });
      fs.writeFileSync(
        path.join(stageAppDir, "package.json"),
        JSON.stringify({ name: "desktop-stage", type: "module" })
      );
      fs.writeFileSync(
        path.join(stageAppDir, "node_modules", "@repo", "api", "package.json"),
        JSON.stringify({ name: "@repo/api", type: "module" })
      );
      fs.writeFileSync(helperPath, "export {};\n");

      assert.equal(
        fs.realpathSync(
          resolveStagedPackageRuntimeFile(
            stageAppDir,
            "@repo/api",
            "dist/session-trace/derivation.js"
          )
        ),
        fs.realpathSync(helperPath)
      );
      assert.throws(() =>
        resolveStagedPackageRuntimeFile(
          stageAppDir,
          "@repo/api",
          "dist/session-trace/not-derivation.js"
        )
      );
    } finally {
      fs.rmSync(stageAppDir, { recursive: true, force: true });
    }
  });

  test("loads the source-bundled Session Trace helper and its transitive runtime imports", async () => {
    // The desktop main process inlines @repo/api from source (PLN-999), so the
    // runtime-relevant assertion is that the SOURCE module the desktop bundles
    // (sqlite.ts -> @repo/api/src/session-trace/derivation) and its transitive
    // imports load and evaluate — not @repo/api's standalone dist output, which
    // the desktop runtime no longer loads.
    const helper = await import("@repo/api/src/session-trace/derivation");

    assert.equal(helper.getAutonomyLabel(80), helper.AutonomyLabel.Agentic);
  });

  test("does not stage @repo/api's transitive shared-platform — also bundled", () => {
    // shared-platform is inlined transitively via @repo/api (FEA-1513), so it
    // too leaves the staged runtime closure (PLN-999).
    assert.equal(closureDirFor("@repo/shared-platform"), undefined);
  });

  test("does not stage @closedloop-ai/loops-api — now source-inlined into the main bundle", () => {
    // loops-api is no longer published/pre-built; its `exports` resolve to `.ts`
    // source, so the main process inlines it (WORKSPACE_INLINE) rather than
    // shipping a dist through the runtime closure. Its only runtime dep
    // (@pydantic/genai-prices) is bundled with it, so it needs no closure entry.
    assert.equal(closureDirFor("@closedloop-ai/loops-api"), undefined);
  });

  test("stages telemetry-contract for the external desktop OTel runtime import", () => {
    const runtimeSource = fs.readFileSync(
      "src/main/app-otel-runtime.ts",
      "utf8"
    );

    assert.match(runtimeSource, TELEMETRY_CONTRACT_ATTRIBUTE_IMPORT);
    assert.equal(
      closureDirFor("@closedloop-ai/telemetry-contract"),
      "telemetry-contract"
    );
  });
});

describe("resolveWorkspaceDependencyTarget", () => {
  test("plain workspace ranges install under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "@closedloop-ai/loops-api",
        "workspace:*"
      ),
      "@closedloop-ai/loops-api"
    );
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/api", "workspace:^1.2.3"),
      "@repo/api"
    );
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/api", "workspace:~0.1.0"),
      "@repo/api"
    );
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/api", "workspace:0.0.0"),
      "@repo/api"
    );
  });

  test("aliased workspace specs resolve to the scoped target package", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "@repo/shared-platform",
        "workspace:@closedloop-ai/shared-platform@*"
      ),
      "@repo/shared-platform"
    );
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "@repo/shared-platform",
        "workspace:@closedloop-ai/shared-platform@^0.1.0"
      ),
      "@repo/shared-platform"
    );
  });

  test("aliased workspace specs resolve to an unscoped target package", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("my-alias", "workspace:real-pkg@*"),
      "real-pkg"
    );
  });

  test("link specs install under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/api", "link:../api"),
      "@repo/api"
    );
  });
});

describe("isWorkspaceProtocolSpec", () => {
  test("recognises workspace and link specs", () => {
    assert.equal(isWorkspaceProtocolSpec("workspace:*"), true);
    assert.equal(isWorkspaceProtocolSpec("workspace:@scope/name@*"), true);
    assert.equal(isWorkspaceProtocolSpec("link:../api"), true);
  });

  test("rejects registry specs and non-strings", () => {
    assert.equal(isWorkspaceProtocolSpec("^4.3.6"), false);
    assert.equal(
      isWorkspaceProtocolSpec("npm:@closedloop-ai/shared-platform@0.1.0"),
      false
    );
    assert.equal(isWorkspaceProtocolSpec(undefined), false);
    assert.equal(isWorkspaceProtocolSpec(null), false);
  });
});
