/**
 * @file coaching-distribution-install.test.ts
 * @description Unit tests for the coaching-pack distribution slice (FEA-2923
 * batch 5): (1) `RequiredPluginInstaller` routes `coaching:true` distributions
 * to the coaching install path (NOT the generic pack_catalog streamRun path),
 * and (2) `installCoachingDistribution` downloads/extracts the asset and calls
 * `installCoachingPackFromDistribution`, honoring override precedence.
 *
 * These fail if the coaching branch were removed (routing) or if the download/
 * extract/install helper were a no-op (end-to-end).
 */

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
  DistributionDto,
  DistributionStatusReport,
} from "@repo/api/src/types/distribution";
import {
  coachingPackSlug,
  installCoachingPackFromDistribution,
  shouldHonorDistributionDefault,
} from "../src/main/agent-coaching-packs.js";
import { installCoachingDistribution } from "../src/main/packs/coaching-distribution-install.js";
import { RequiredPluginInstaller } from "../src/main/packs/required-plugin-installer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "coaching-dist-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCoachingDistribution(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "ci-1",
    catalogItem: {
      id: "ci-1",
      name: "Token Coach",
      targetKind: "plugin",
      source: "curated",
      coaching: true,
    },
    mode: "auto_install",
    targetingType: "all",
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: "https://example.test/asset.zip",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeCoachingPackSource(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "coaching-pack.json"),
    JSON.stringify({
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["keep the prefix stable"],
    })
  );
}

// ---------------------------------------------------------------------------
// RequiredPluginInstaller routing
// ---------------------------------------------------------------------------

describe("RequiredPluginInstaller coaching routing", () => {
  test("routes coaching:true distributions to installCoachingDistribution, not runInstall", async () => {
    const assigned = [makeCoachingDistribution()];
    let runInstallCalls = 0;
    let coachingCalls = 0;

    // Fake the distributions client fetch: assigned GET returns the coaching
    // distribution; status POST captures the report.
    const fakeFetch = ((url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("/desktop/distributions/assigned")) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, data: assigned }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      // status POST
      return Promise.resolve(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const installer = new RequiredPluginInstaller({
      distributionsClient: {
        fetch: fakeFetch,
        getAccessToken: () => Promise.resolve("token"),
        getApiOrigin: () => "https://example.test",
      },
      runInstall: () => {
        runInstallCalls += 1;
        return Promise.resolve({ started: true, runId: 1 });
      },
      getInstalledVersion: () => Promise.resolve(null),
      installCoachingDistribution: (dist) => {
        coachingCalls += 1;
        assert.equal(dist.id, "dist-1");
        return Promise.resolve({
          status: "installed",
          installedVersion: "1.0.0",
        });
      },
    });

    await installer.reconcile("ct-1");

    assert.equal(
      coachingCalls,
      1,
      "coaching install path must be invoked once"
    );
    assert.equal(
      runInstallCalls,
      0,
      "generic pack install must NOT run for a coaching distribution"
    );
  });

  test("reports pending when the coaching callback is not wired", async () => {
    const assigned = [makeCoachingDistribution()];
    let statusBody: unknown;
    const fakeFetch = ((url: string | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("/desktop/distributions/assigned")) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, data: assigned }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      statusBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const installer = new RequiredPluginInstaller({
      distributionsClient: {
        fetch: fakeFetch,
        getAccessToken: () => Promise.resolve("token"),
        getApiOrigin: () => "https://example.test",
      },
      runInstall: () => Promise.resolve({ started: true, runId: 1 }),
      getInstalledVersion: () => Promise.resolve(null),
      // installCoachingDistribution intentionally omitted.
    });

    await installer.reconcile("ct-1");

    const body = statusBody as {
      reports: DistributionStatusReport[];
    };
    assert.ok(body?.reports?.length, "a status report must be sent");
    assert.equal(body.reports[0].distributionId, "dist-1");
    assert.equal(body.reports[0].status, "pending");
  });

  test("reports pending (not installed) when the coaching feature flag is off", async () => {
    // The install callback returns `disabled` (feature-flag off in app.ts). The
    // device did NOT converge, so the cloud must see `pending`, never a false
    // `installed`.
    const assigned = [makeCoachingDistribution()];
    let statusBody: unknown;
    const fakeFetch = ((url: string | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("/desktop/distributions/assigned")) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, data: assigned }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      statusBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const installer = new RequiredPluginInstaller({
      distributionsClient: {
        fetch: fakeFetch,
        getAccessToken: () => Promise.resolve("token"),
        getApiOrigin: () => "https://example.test",
      },
      runInstall: () => Promise.resolve({ started: true, runId: 1 }),
      getInstalledVersion: () => Promise.resolve(null),
      installCoachingDistribution: () =>
        Promise.resolve({ status: "disabled" }),
    });

    await installer.reconcile("ct-1");

    const body = statusBody as { reports: DistributionStatusReport[] };
    assert.ok(body?.reports?.length, "a status report must be sent");
    assert.equal(body.reports[0].distributionId, "dist-1");
    assert.equal(
      body.reports[0].status,
      "pending",
      "feature-flag-off must report pending, never a false installed"
    );
  });
});

// ---------------------------------------------------------------------------
// installCoachingDistribution end-to-end
// ---------------------------------------------------------------------------

describe("installCoachingDistribution", () => {
  test("downloads, extracts, and installs a coaching pack", async () => {
    const packsDir = path.join(root, "coaching-packs");
    const sourcePack = path.join(root, "source-pack");
    writeCoachingPackSource(sourcePack);

    let downloadedUrl: string | undefined;
    const fakeFetch = ((url: string | URL) => {
      downloadedUrl = typeof url === "string" ? url : url.toString();
      // 4 arbitrary bytes standing in for a zip payload.
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      {
        packsDir,
        coachingPackSlug,
        shouldHonorDistributionDefault,
        installCoachingPackFromDistribution,
        fetch: fakeFetch,
        // Extractor stub: "extract" == copy our prepared pack into destDir.
        extractZip: (_bytes, destDir) => {
          cpSync(sourcePack, destDir, { recursive: true });
        },
      }
    );

    assert.equal(downloadedUrl, "https://example.test/asset.zip");
    assert.equal(outcome.status, "installed");
    assert.equal(outcome.installedVersion, "1.0.0");
    // The pack landed in the managed store under its slug.
    const slug = coachingPackSlug("Token Coach");
    assert.ok(slug);
    assert.ok(
      existsSync(path.join(packsDir, slug, "coaching-pack.json")),
      "installed pack manifest must exist in the store"
    );
  });

  test("skips (override precedence) when a user choice is already recorded", async () => {
    const packsDir = path.join(root, "coaching-packs");
    mkdirSync(packsDir, { recursive: true });
    // Record a prior choice: active.json exists → distribution must NOT clobber.
    writeFileSync(
      path.join(packsDir, "active.json"),
      JSON.stringify({ slug: "my-pick" })
    );

    let downloadCalls = 0;
    const fakeFetch = (() => {
      downloadCalls += 1;
      return Promise.resolve(
        new Response(new Uint8Array([1]), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      {
        packsDir,
        coachingPackSlug,
        shouldHonorDistributionDefault,
        installCoachingPackFromDistribution,
        fetch: fakeFetch,
        extractZip: () => {
          throw new Error("must not extract when precedence declines");
        },
      }
    );

    assert.equal(outcome.status, "skipped");
    assert.equal(downloadCalls, 0, "must not download when skipping");
  });

  test("fails when there is no asset download URL", async () => {
    const outcome = await installCoachingDistribution(
      makeCoachingDistribution({ assetDownloadUrl: null }),
      {
        packsDir: path.join(root, "coaching-packs"),
        coachingPackSlug,
        shouldHonorDistributionDefault,
        installCoachingPackFromDistribution,
        fetch: (() =>
          Promise.resolve(new Response(null))) as unknown as typeof fetch,
        extractZip: () => undefined,
      }
    );
    assert.equal(outcome.status, "failed");
  });
});
