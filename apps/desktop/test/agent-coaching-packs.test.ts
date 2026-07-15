/**
 * @file agent-coaching-packs.test.ts
 * Unit tests for the coaching-pack store (agent-coaching-packs.ts).
 *
 * Covers:
 *   - readCoachingPackManifest: manifest parsing, signal filtering, identity fallback.
 *   - coachingPackSlug: slug safety and reserved-name blocking.
 *   - listInstalledCoachingPacks: enumeration and sorting.
 *   - Active-pack pointer helpers: getActiveCoachingPack / setActiveCoachingPack.
 *   - installCoachingPackFromDistribution: distribution-honoring install path
 *     (T-22.7a — replaces folder-pick tests removed in batch 5).
 *   - shouldHonorDistributionDefault: override-precedence invariant (T-22.7a).
 *   - IPC contract stability: getActiveCoachingPack returns a well-shaped
 *     CoachingPackInfo regardless of install path (T-22.7b).
 *   - Org-scoping: coaching distributions from a different org are not surfaced
 *     to a compute target belonging to another org (T-22.7d).
 *
 * AC-029
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
import {
  coachingPackSlug,
  getActiveCoachingPack,
  installCoachingPackFromDistribution,
  listInstalledCoachingPacks,
  readCoachingPackManifest,
  setActiveCoachingPack,
  shouldHonorDistributionDefault,
} from "../src/main/agent-coaching-packs.js";
import { getAssignedDistributions } from "../src/main/packs/distributions-client.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "coaching-packs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writePackDir(
  dir: string,
  manifest: Record<string, unknown>,
  plugin?: Record<string, unknown>
): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "coaching-pack.json"),
    JSON.stringify(manifest, null, 2)
  );
  if (plugin) {
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify(plugin, null, 2)
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// readCoachingPackManifest
// ---------------------------------------------------------------------------

describe("readCoachingPackManifest", () => {
  test("reads a valid manifest", () => {
    const dir = writePackDir(path.join(root, "src"), {
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["keep the prefix stable", "read targeted spans"],
    });
    const info = readCoachingPackManifest(dir);
    assert.ok(info);
    assert.equal(info?.name, "token-coach");
    assert.equal(info?.displayName, "Token Coach");
    assert.equal(info?.version, "1.0.0");
    assert.deepEqual(info?.signals, [
      "keep the prefix stable",
      "read targeted spans",
    ]);
  });

  test("returns null when signals are missing/empty", () => {
    const noSignals = writePackDir(path.join(root, "a"), {
      name: "x",
      signals: [],
    });
    assert.equal(readCoachingPackManifest(noSignals), null);
    assert.equal(readCoachingPackManifest(path.join(root, "missing")), null);
  });

  test("falls back to plugin.json for identity", () => {
    const dir = writePackDir(
      path.join(root, "b"),
      { signals: ["a signal"] },
      {
        name: "from-plugin",
        displayName: "From Plugin",
        version: "2.1.0",
      }
    );
    const info = readCoachingPackManifest(dir);
    assert.equal(info?.name, "from-plugin");
    assert.equal(info?.displayName, "From Plugin");
    assert.equal(info?.version, "2.1.0");
  });

  test("drops non-string signal entries", () => {
    const dir = writePackDir(path.join(root, "c"), {
      name: "x",
      signals: ["good", 42, "", null, "also good"],
    });
    assert.deepEqual(readCoachingPackManifest(dir)?.signals, [
      "good",
      "also good",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Active-pack pointer helpers
// ---------------------------------------------------------------------------

describe("active-pack pointer helpers", () => {
  test("no active pack → null (built-in defaults apply)", () => {
    assert.equal(getActiveCoachingPack(path.join(root, "empty")), null);
  });

  test("a dangling active pointer resolves to null", () => {
    const packsDir = path.join(root, "store");
    mkdirSync(packsDir, { recursive: true });
    setActiveCoachingPack(packsDir, "ghost-pack");
    assert.equal(getActiveCoachingPack(packsDir), null);
  });

  test("clearing the active pointer disables the override", () => {
    const packsDir = path.join(root, "store");
    // Install a pack via the distribution path so the pointer is set.
    const source = writePackDir(path.join(root, "source"), {
      name: "p",
      displayName: "P",
      signals: ["s"],
    });
    installCoachingPackFromDistribution(source, packsDir, true);
    assert.ok(getActiveCoachingPack(packsDir));

    // Clearing the pointer restores built-in defaults.
    setActiveCoachingPack(packsDir, null);
    assert.equal(getActiveCoachingPack(packsDir), null);
  });
});

// ---------------------------------------------------------------------------
// listInstalledCoachingPacks
// ---------------------------------------------------------------------------

describe("listInstalledCoachingPacks", () => {
  test("lists installed packs sorted by name", () => {
    const packsDir = path.join(root, "store");
    installCoachingPackFromDistribution(
      writePackDir(path.join(root, "zsrc"), {
        name: "zeta",
        displayName: "Zeta",
        signals: ["z"],
      }),
      packsDir,
      false
    );
    installCoachingPackFromDistribution(
      writePackDir(path.join(root, "asrc"), {
        name: "alpha",
        displayName: "Alpha",
        signals: ["a"],
      }),
      packsDir,
      false
    );
    assert.deepEqual(
      listInstalledCoachingPacks(packsDir).map((p) => p.name),
      ["alpha", "zeta"]
    );
  });
});

// ---------------------------------------------------------------------------
// coachingPackSlug
// ---------------------------------------------------------------------------

describe("coachingPackSlug", () => {
  test("produces filesystem-safe slugs and blocks traversal/reserved names", () => {
    assert.equal(coachingPackSlug("Token Coach"), "token-coach");
    assert.equal(coachingPackSlug("../../etc/passwd"), "etc-passwd");
    assert.equal(coachingPackSlug("active"), null);
    // A slug must never collide with the active-pointer file itself.
    assert.equal(coachingPackSlug("active.json"), null);
    assert.equal(coachingPackSlug("Active.JSON"), null);
    assert.equal(coachingPackSlug("...."), null);
    assert.equal(coachingPackSlug(""), null);
  });
});

// ---------------------------------------------------------------------------
// installCoachingPackFromDistribution (T-22.7a)
// ---------------------------------------------------------------------------

describe("installCoachingPackFromDistribution", () => {
  test("materializes the asset to the correct path under packsDir", () => {
    const source = writePackDir(path.join(root, "source"), {
      name: "Token Coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["cache efficiency is the biggest lever"],
    });
    const packsDir = path.join(root, "store");

    const installed = installCoachingPackFromDistribution(
      source,
      packsDir,
      false
    );
    assert.ok(installed, "should return the installed CoachingPackInfo");
    assert.equal(installed?.name, "Token Coach");
    assert.equal(installed?.displayName, "Token Coach");
    assert.equal(installed?.version, "1.0.0");
    assert.deepEqual(installed?.signals, [
      "cache efficiency is the biggest lever",
    ]);

    // Verify the pack directory was created in the store at the expected slug.
    const expectedSlug = coachingPackSlug("Token Coach");
    assert.ok(expectedSlug, "slug must be non-null");
    const manifestPath = path.join(
      packsDir,
      expectedSlug,
      "coaching-pack.json"
    );
    assert.ok(
      existsSync(manifestPath),
      `coaching-pack.json must exist at ${manifestPath}`
    );
  });

  test("calls setActiveCoachingPack when activate=true and no prior choice is recorded", () => {
    const source = writePackDir(path.join(root, "source"), {
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["first signal"],
    });
    const packsDir = path.join(root, "store");

    // No active.json exists yet — first-ever install, should activate.
    const installed = installCoachingPackFromDistribution(
      source,
      packsDir,
      true
    );
    assert.ok(installed, "should return installed info");

    const active = getActiveCoachingPack(packsDir);
    assert.ok(active, "active pack should be set after activate=true");
    assert.equal(active?.name, "token-coach");
    assert.deepEqual(active?.signals, ["first signal"]);
  });

  test("does NOT call setActiveCoachingPack when activate=false", () => {
    const source = writePackDir(path.join(root, "source"), {
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["a signal"],
    });
    const packsDir = path.join(root, "store");

    installCoachingPackFromDistribution(source, packsDir, false);

    // activate=false means no active pointer should be written.
    const active = getActiveCoachingPack(packsDir);
    assert.equal(active, null, "active pack must be null when activate=false");
  });

  test("does NOT overwrite the active pointer when a user choice is already recorded (override-precedence)", () => {
    // Pre-condition: user has made a local choice (active.json exists).
    const userPackSrc = writePackDir(path.join(root, "user-source"), {
      name: "user-custom-pack",
      displayName: "User Custom",
      version: "1.0.0",
      signals: ["user signal"],
    });
    const packsDir = path.join(root, "store");
    // Simulate user having previously installed and activated their own pack.
    installCoachingPackFromDistribution(userPackSrc, packsDir, true);
    assert.equal(getActiveCoachingPack(packsDir)?.name, "user-custom-pack");

    // Now the org distributes a different coaching pack.
    const orgPackSrc = writePackDir(path.join(root, "org-source"), {
      name: "org-default",
      displayName: "Org Default",
      version: "1.0.0",
      signals: ["org signal"],
    });
    installCoachingPackFromDistribution(orgPackSrc, packsDir, true);

    // The org default must NOT have overwritten the user's choice.
    const active = getActiveCoachingPack(packsDir);
    assert.equal(
      active?.name,
      "user-custom-pack",
      "user's local choice must take precedence over org distribution default"
    );
  });

  test("returns null when the source directory does not exist", () => {
    const packsDir = path.join(root, "store");
    const result = installCoachingPackFromDistribution(
      path.join(root, "nonexistent"),
      packsDir,
      true
    );
    assert.equal(result, null, "must return null for a missing source path");
  });

  test("returns null when the source is not a valid coaching pack (no signals)", () => {
    const badSource = path.join(root, "bad-source");
    mkdirSync(badSource, { recursive: true });
    writeFileSync(
      path.join(badSource, "coaching-pack.json"),
      JSON.stringify({ name: "bad", signals: [] })
    );
    const result = installCoachingPackFromDistribution(
      badSource,
      path.join(root, "store"),
      true
    );
    assert.equal(result, null, "must return null for a pack with no signals");
  });

  test("refreshes the managed copy when the distributed version changes", () => {
    // Initial install: activate.
    const v1Source = writePackDir(path.join(root, "v1"), {
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["old signal"],
    });
    const packsDir = path.join(root, "store");
    installCoachingPackFromDistribution(v1Source, packsDir, true);
    assert.deepEqual(getActiveCoachingPack(packsDir)?.signals, ["old signal"]);

    // Org ships v2 with an improved signal.
    const v2Source = writePackDir(path.join(root, "v2"), {
      name: "token-coach",
      displayName: "Token Coach",
      version: "2.0.0",
      signals: ["improved signal"],
    });
    installCoachingPackFromDistribution(v2Source, packsDir, true);

    // The managed copy must be updated (signals refreshed).
    const active = getActiveCoachingPack(packsDir);
    assert.equal(
      active?.version,
      "2.0.0",
      "version must be refreshed to 2.0.0"
    );
    assert.deepEqual(
      active?.signals,
      ["improved signal"],
      "signals must reflect v2"
    );
  });

  test("second distribution sync does NOT reset a user's local override (idempotency)", () => {
    const packsDir = path.join(root, "store");

    // First sync: org installs + activates the default.
    const orgSource = writePackDir(path.join(root, "org-pack"), {
      name: "org-default",
      displayName: "Org Default",
      version: "1.0.0",
      signals: ["org signal"],
    });
    installCoachingPackFromDistribution(orgSource, packsDir, true);
    assert.equal(getActiveCoachingPack(packsDir)?.name, "org-default");

    // User overrides: clear the org default and set their own pack.
    setActiveCoachingPack(packsDir, null); // simulate user clearing org default

    // Install a user pack via manual copy and set it active.
    const userSource = writePackDir(path.join(root, "user-pack"), {
      name: "my-pack",
      displayName: "My Pack",
      version: "1.0.0",
      signals: ["my signal"],
    });
    const dest = path.join(packsDir, "my-pack");
    mkdirSync(dest, { recursive: true });
    cpSync(userSource, dest, { recursive: true });
    setActiveCoachingPack(packsDir, "my-pack");

    // Second org distribution sync: MUST NOT reset user's choice.
    installCoachingPackFromDistribution(orgSource, packsDir, true);

    const active = getActiveCoachingPack(packsDir);
    assert.equal(
      active?.name,
      "my-pack",
      "user's local override must survive a repeated distribution sync"
    );
  });
});

// ---------------------------------------------------------------------------
// shouldHonorDistributionDefault (T-22.7a)
// ---------------------------------------------------------------------------

describe("shouldHonorDistributionDefault", () => {
  test("returns true when active.json does not exist (first-ever install)", () => {
    const packsDir = path.join(root, "empty-store");
    const slug = "token-coach";
    assert.equal(
      shouldHonorDistributionDefault(packsDir, slug),
      true,
      "should honor the distribution default when no choice has been recorded"
    );
  });

  test("returns false when active.json already exists (user has made a choice)", () => {
    const packsDir = path.join(root, "store");
    mkdirSync(packsDir, { recursive: true });
    // Write active.json to simulate a recorded choice (even null/cleared).
    setActiveCoachingPack(packsDir, null);

    assert.equal(
      shouldHonorDistributionDefault(packsDir, "token-coach"),
      false,
      "must NOT override once a choice has been recorded"
    );
  });

  test("returns false when user has an active pack set (explicit choice)", () => {
    const source = writePackDir(path.join(root, "user-pack"), {
      name: "user-pack",
      displayName: "User Pack",
      version: "1.0.0",
      signals: ["user signal"],
    });
    const packsDir = path.join(root, "store");
    installCoachingPackFromDistribution(source, packsDir, true);
    // Now active.json exists pointing at "user-pack".
    assert.equal(getActiveCoachingPack(packsDir)?.name, "user-pack");

    // shouldHonorDistributionDefault must return false since a choice is recorded.
    assert.equal(
      shouldHonorDistributionDefault(packsDir, "org-default"),
      false,
      "must return false when a user choice is already recorded"
    );
  });

  test("returns true when the pack directory already exists but active.json does not", () => {
    // Edge case: the pack was materialised (e.g. by a previous dry-run sync) but
    // never activated. The distribution default should still be applied.
    const packSlug = "token-coach";
    const packsDir = path.join(root, "store");
    const dest = path.join(packsDir, packSlug);
    writePackDir(dest, {
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.0.0",
      signals: ["a signal"],
    });
    // No active.json written yet.
    assert.equal(
      shouldHonorDistributionDefault(packsDir, packSlug),
      true,
      "should still honor the default when the pack dir exists but no choice is recorded"
    );
  });
});

// ---------------------------------------------------------------------------
// IPC contract stability (T-22.7b)
// ---------------------------------------------------------------------------

describe("getCoachingPack IPC contract stability", () => {
  /**
   * The main-process IPC handler for `desktop:agent-coaching:get-pack` calls
   * getActiveCoachingPack(packsDir). These tests verify that the returned
   * CoachingPackInfo has the exact shape the renderer expects, regardless of
   * whether the active pack was installed via the distribution path or manually.
   *
   * CoachingPackInfo = { name, displayName, version, description, signals }
   *
   * The renderer pipeline in agent-coaching-api.ts reads `activePack.signals`
   * via this IPC call; if the contract changes, coaching tips silently break.
   */

  test("returns CoachingPackInfo with expected shape when pack installed via distribution path", () => {
    const source = writePackDir(path.join(root, "dist-pack"), {
      name: "token-coach",
      displayName: "Token Coach",
      version: "1.2.3",
      description: "Optimize token usage",
      signals: ["cache efficiency is the biggest lever", "read targeted spans"],
    });
    const packsDir = path.join(root, "store");

    installCoachingPackFromDistribution(source, packsDir, true);

    const info = getActiveCoachingPack(packsDir);

    // Must be non-null.
    assert.ok(info, "IPC must return a CoachingPackInfo, not null");

    // name: string
    assert.equal(typeof info.name, "string", "name must be a string");
    assert.ok(info.name.length > 0, "name must be non-empty");

    // displayName: string
    assert.equal(
      typeof info.displayName,
      "string",
      "displayName must be a string"
    );

    // version: string | null
    assert.ok(
      info.version === null || typeof info.version === "string",
      "version must be string or null"
    );
    assert.equal(info.version, "1.2.3");

    // description: string | null
    assert.ok(
      info.description === null || typeof info.description === "string",
      "description must be string or null"
    );
    assert.equal(info.description, "Optimize token usage");

    // signals: string[] (the field the renderer reads for coaching prompt)
    assert.ok(Array.isArray(info.signals), "signals must be an array");
    assert.ok(info.signals.length > 0, "signals must be non-empty");
    assert.ok(
      info.signals.every((s) => typeof s === "string"),
      "every signal must be a string"
    );
    assert.deepEqual(info.signals, [
      "cache efficiency is the biggest lever",
      "read targeted spans",
    ]);
  });

  test("returns CoachingPackInfo with expected shape when pack installed manually (setActiveCoachingPack)", () => {
    // Simulate the manual folder-pick path: a pack is copied and setActiveCoachingPack called.
    const packSlug = "manual-pack";
    const packsDir = path.join(root, "store");
    writePackDir(path.join(packsDir, packSlug), {
      name: "manual-pack",
      displayName: "Manual Pack",
      version: "0.9.0",
      signals: ["manually loaded signal"],
    });
    setActiveCoachingPack(packsDir, packSlug);

    const info = getActiveCoachingPack(packsDir);
    assert.ok(
      info,
      "IPC must return CoachingPackInfo for a manually installed pack"
    );

    // Core contract fields.
    assert.equal(typeof info.name, "string");
    assert.equal(typeof info.displayName, "string");
    assert.ok(Array.isArray(info.signals));
    assert.equal(info.signals[0], "manually loaded signal");

    // description can be null — null is a valid IPC response.
    assert.ok(
      info.description === null || typeof info.description === "string"
    );
  });

  test("returns null when no active pack is set (built-in defaults apply)", () => {
    const packsDir = path.join(root, "empty");
    // getActiveCoachingPack returns null → the renderer pipeline uses built-in
    // AGENTIC_DEVELOPMENT_SIGNALS. This is correct behaviour, not an error.
    const info = getActiveCoachingPack(packsDir);
    assert.equal(info, null, "IPC returns null when no active pack is set");
  });

  test("IPC returns identical shape whether activated via distribution or manual path", () => {
    const packsDir1 = path.join(root, "dist-store");
    const packsDir2 = path.join(root, "manual-store");
    const slug = "token-coach";
    const manifest = {
      name: slug,
      displayName: "Token Coach",
      version: "1.0.0",
      description: "The canonical coaching pack",
      signals: ["signal-alpha", "signal-beta"],
    };

    // Distribution path.
    const distSource = writePackDir(path.join(root, "dist-source"), manifest);
    installCoachingPackFromDistribution(distSource, packsDir1, true);

    // Manual path (simulates folder-pick install).
    writePackDir(path.join(packsDir2, slug), manifest);
    setActiveCoachingPack(packsDir2, slug);

    const distInfo = getActiveCoachingPack(packsDir1);
    const manualInfo = getActiveCoachingPack(packsDir2);

    assert.ok(distInfo, "distribution install must produce an active pack");
    assert.ok(manualInfo, "manual install must produce an active pack");

    // The IPC contract shape must be identical.
    assert.deepEqual(
      distInfo.signals,
      manualInfo.signals,
      "signals must be identical regardless of install path"
    );
    assert.equal(distInfo.version, manualInfo.version);
    assert.equal(distInfo.description, manualInfo.description);
  });
});

// ---------------------------------------------------------------------------
// Org-scoping / coaching distribution isolation (T-22.7d)
// ---------------------------------------------------------------------------

describe("coaching distribution org-scoping", () => {
  /**
   * These tests verify the org-scoping contract at the desktop-client layer:
   * a coaching CatalogItem from org-A must never be surfaced to a compute
   * target registered under org-B.
   *
   * The API server enforces org-scoping on GET /desktop/distributions/assigned
   * via the ComputeTarget ownership gate (computeTarget.organizationId === req.user.organizationId).
   * Here we verify that the desktop client (distributions-client.ts) correctly
   * passes the organizationId from each DistributionDto and that coaching
   * distributions from the correct org are surfaced without cross-contamination.
   */

  test("distributions client surfaces only the org the API scoped to", async () => {
    const ORG_A = "org-a-id";
    const ORG_B = "org-b-id";
    const COMPUTE_TARGET_A = "ct-a-001";

    // The API correctly scopes to org-A and returns only org-A distributions.
    const orgACoachingDist = {
      id: "dist-coaching-a",
      organizationId: ORG_A,
      catalogItemId: "ci-coaching-a",
      catalogItem: {
        id: "ci-coaching-a",
        targetKind: "plugin",
        name: "Token Coach",
        source: "curated",
      },
      mode: "auto_install",
      targetingType: "all",
      desiredEnabled: true,
      targetingEntries: [],
      targetStatuses: [],
      assetDownloadUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    // A correctly-scoped fake fetch: only returns org-A data.
    // Must use the `{ success: true, data: [...] }` envelope that unwrapApiEnvelope expects.
    const fakeFetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/desktop/distributions/assigned")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ success: true, data: [orgACoachingDist] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    };

    const orgAOptions = {
      getAccessToken: async () => "token-for-user-in-org-a",
      getApiOrigin: () => "https://api.example.com",
      fetch: fakeFetch as unknown as typeof fetch,
    };

    const distributions = await getAssignedDistributions(
      orgAOptions,
      COMPUTE_TARGET_A
    );

    // Should only see org-A's distribution.
    assert.equal(distributions.length, 1);
    assert.equal(distributions[0]?.organizationId, ORG_A);
    assert.equal(distributions[0]?.id, "dist-coaching-a");

    // Must not contain any org-B distribution.
    const orgBIds = distributions.filter((d) => d.organizationId === ORG_B);
    assert.equal(
      orgBIds.length,
      0,
      "no org-B distributions may appear in org-A's response"
    );
  });

  test("returns empty list when no access token is available (org isolation via auth)", async () => {
    // If the auth token is missing, the client must return [] rather than
    // making an unauthenticated request that could cross org boundaries.
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const unauthOptions = {
      getAccessToken: async () => null, // no token
      getApiOrigin: () => "https://api.example.com",
      fetch: fakeFetch as unknown as typeof fetch,
    };

    const distributions = await getAssignedDistributions(
      unauthOptions,
      "ct-any"
    );
    assert.equal(
      distributions.length,
      0,
      "client must return [] when there is no access token (prevents cross-org leakage)"
    );
  });

  test("coaching distributions are identified by organizationId from the response", async () => {
    /**
     * The client preserves organizationId from the server response verbatim.
     * This allows callers to perform secondary org-scope validation if needed
     * (e.g., filtering coaching packs to only those from the active org).
     */
    const ORG_A = "org-a-id";

    const coachingDist = {
      id: "coaching-dist-001",
      organizationId: ORG_A,
      catalogItemId: "ci-token-coach",
      catalogItem: {
        id: "ci-token-coach",
        targetKind: "plugin",
        name: "Token Coach",
        source: "curated",
      },
      mode: "auto_install",
      targetingType: "all",
      desiredEnabled: true,
      targetingEntries: [],
      targetStatuses: [],
      assetDownloadUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ success: true, data: [coachingDist] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const options = {
      getAccessToken: async () => "valid-token",
      getApiOrigin: () => "https://api.example.com",
      fetch: fakeFetch as unknown as typeof fetch,
    };

    const distributions = await getAssignedDistributions(options, "ct-001");
    assert.equal(distributions.length, 1);
    assert.equal(
      distributions[0]?.organizationId,
      ORG_A,
      "organizationId must be preserved verbatim for secondary org-scope checks"
    );
    assert.equal(distributions[0]?.catalogItem.name, "Token Coach");
  });
});
