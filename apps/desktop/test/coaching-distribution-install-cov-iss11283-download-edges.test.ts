/**
 * @file coaching-distribution-install-cov-iss11283-download-edges.test.ts
 * @description ISS-11283 lane D branch-coverage addendum for
 * `packs/coaching-distribution-install.ts`. The existing
 * `coaching-distribution-install.test.ts` covers the routing, the happy
 * download/extract/install path, override precedence, the https guard, the
 * redirect guard, and the two size-cap failure paths; this file targets the
 * arms it leaves alone: a blank catalog-item name, the default global
 * `fetch` (deps.fetch omitted), a non-Error download rejection, an injected
 * `makeTempDir`, a rejected install (both Error and non-Error), a response
 * with no `version`, and the streamed-body reader skipping a falsy chunk.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DistributionDto } from "@repo/api/src/types/distribution";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  coachingPackSlug,
  installCoachingPackFromDistribution,
  shouldHonorDistributionDefault,
} from "../src/main/agent-monitor/agent-coaching-packs.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import type { CoachingDistributionInstallDeps } from "../src/main/packs/coaching-distribution-install.js";
import { installCoachingDistribution } from "../src/main/packs/coaching-distribution-install.js";

let root: string;

// chmod-based failure injection needs POSIX permission semantics, which root
// bypasses; that case skips rather than passes vacuously there.
const PERMISSION_DENIAL_ENFORCED =
  process.platform !== "win32" && process.getuid?.() !== 0;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "coaching-dist-cov-"));
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

/** Base deps every case overrides pieces of. */
function baseDeps(
  overrides: Partial<CoachingDistributionInstallDeps> = {}
): CoachingDistributionInstallDeps {
  return {
    packsDir: path.join(root, "coaching-packs"),
    coachingPackSlug,
    shouldHonorDistributionDefault,
    installCoachingPackFromDistribution,
    extractZip: () => {
      throw new Error("test forgot to override extractZip");
    },
    ...overrides,
  };
}

describe("installCoachingDistribution: an invalid catalog-item name", () => {
  it("fails without deriving a slug when the catalog item name is blank", async () => {
    let slugCalls = 0;
    const outcome = await installCoachingDistribution(
      makeCoachingDistribution({
        catalogItem: {
          id: "ci-1",
          name: "",
          targetKind: "plugin",
          source: "curated",
          coaching: true,
        },
      }),
      baseDeps({
        coachingPackSlug: (name) => {
          slugCalls += 1;
          return coachingPackSlug(name);
        },
        extractZip: () => {
          throw new Error("must not extract for a nameless catalog item");
        },
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureReason, "invalid coaching pack name");
    assert.equal(
      slugCalls,
      0,
      "a blank name must short-circuit before calling coachingPackSlug"
    );
  });
});

describe("installCoachingDistribution: the default fetch (deps.fetch omitted)", () => {
  it("falls back to the global fetch when no deps.fetch is injected", async () => {
    const packsDir = path.join(root, "coaching-packs");
    const sourcePack = path.join(root, "source-pack");
    writeCoachingPackSource(sourcePack);
    const originalFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = ((url: string | URL) => {
      globalFetchCalls += 1;
      assert.equal(String(url), "https://example.test/asset.zip");
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      );
    }) as typeof fetch;

    try {
      const outcome = await installCoachingDistribution(
        makeCoachingDistribution(),
        baseDeps({
          packsDir,
          extractZip: (_bytes, destDir) => {
            cpSync(sourcePack, destDir, { recursive: true });
          },
        })
      );

      assert.equal(outcome.status, "installed");
      // `installed.version ?? null` — the real manifest's declared version
      // ("1.0.0" from `writeCoachingPackSource`) must win over the fallback,
      // pinning that `??` and not a mutation that discards a truthy version.
      assert.equal(outcome.installedVersion, "1.0.0");
      assert.equal(
        globalFetchCalls,
        1,
        "the global fetch must be used when deps.fetch is omitted"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("installCoachingDistribution: a non-Error download rejection", () => {
  it("stringifies a non-Error thrown by the injected fetch", async () => {
    const fakeFetch = (() =>
      Promise.reject("network gremlin")) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir: path.join(root, "coaching-packs"),
        fetch: fakeFetch,
        extractZip: () => {
          throw new Error("must not extract when the download rejects");
        },
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureReason, "download failed: network gremlin");
  });
});

describe("installCoachingDistribution: an injected makeTempDir is used over the default", () => {
  it("extracts into the caller-supplied temp directory", async () => {
    const packsDir = path.join(root, "coaching-packs");
    const sourcePack = path.join(root, "source-pack");
    writeCoachingPackSource(sourcePack);
    const customTempDir = path.join(root, "custom-temp");
    mkdirSync(customTempDir, { recursive: true });
    let makeTempDirCalls = 0;
    let extractedInto: string | undefined;
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir,
        fetch: fakeFetch,
        makeTempDir: () => {
          makeTempDirCalls += 1;
          return customTempDir;
        },
        extractZip: (_bytes, destDir) => {
          extractedInto = destDir;
          cpSync(sourcePack, destDir, { recursive: true });
        },
      })
    );

    assert.equal(outcome.status, "installed");
    assert.equal(makeTempDirCalls, 1);
    assert.equal(extractedInto, customTempDir);
  });
});

describe("installCoachingDistribution: a rejected or invalid install", () => {
  it("fails with the canonical message when installCoachingPackFromDistribution returns null", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir: path.join(root, "coaching-packs"),
        fetch: fakeFetch,
        installCoachingPackFromDistribution: () => null,
        extractZip: () => undefined,
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(
      outcome.failureReason,
      "extracted asset is not a valid coaching pack"
    );
  });

  it("reports installedVersion null when the installed pack carries no version", async () => {
    const packsDir = path.join(root, "coaching-packs");
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir,
        fetch: fakeFetch,
        installCoachingPackFromDistribution: () => ({
          name: "token-coach",
          displayName: "Token Coach",
          version: null,
          description: null,
          signals: [],
        }),
        extractZip: () => undefined,
      })
    );

    assert.equal(outcome.status, "installed");
    assert.equal(outcome.installedVersion, null);
  });

  it("logs an Error's message when installCoachingPackFromDistribution throws an Error", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir: path.join(root, "coaching-packs"),
        fetch: fakeFetch,
        installCoachingPackFromDistribution: () => {
          throw new Error("disk full");
        },
        extractZip: () => undefined,
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureReason, "install failed: disk full");
  });

  it("stringifies a non-Error throw from extractZip", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir: path.join(root, "coaching-packs"),
        fetch: fakeFetch,
        extractZip: () => {
          // biome-ignore lint/style/useThrowOnlyError: pins the non-Error catch branch
          throw "corrupt zip";
        },
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureReason, "install failed: corrupt zip");
  });
});

describe("installCoachingDistribution: an HTTP failure status", () => {
  it("fails with the HTTP status when the response is not ok", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(null, { status: 404 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir: path.join(root, "coaching-packs"),
        fetch: fakeFetch,
        extractZip: () => {
          throw new Error("must not extract on a non-ok response");
        },
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureReason, "download failed: HTTP 404");
  });
});

describe("installCoachingDistribution: a null response body falls back to the buffered read", () => {
  it("still installs when the response carries no streamable body", async () => {
    const packsDir = path.join(root, "coaching-packs");
    const sourcePack = path.join(root, "source-pack");
    writeCoachingPackSource(sourcePack);
    let receivedByteLength: number | undefined;
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(null, { status: 200 })
      )) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir,
        fetch: fakeFetch,
        extractZip: (bytes, destDir) => {
          receivedByteLength = bytes.byteLength;
          cpSync(sourcePack, destDir, { recursive: true });
        },
      })
    );

    assert.equal(outcome.status, "installed");
    assert.equal(
      receivedByteLength,
      0,
      "a null response body has no bytes to buffer"
    );
    // NOTE (mutation equivalence): the over-cap check right above this read
    // (`if (arrayBuffer.byteLength > maxBytes)`) is unreachable through a
    // null-body Response — `arrayBuffer()` on a null body always resolves to
    // 0 bytes, so the guard can never observe `byteLength > maxBytes`, and a
    // mutant that disables or loosens it produces no observable difference
    // through this module's public surface.
  });
});

describe("installCoachingDistribution: the streamed reader skips a falsy chunk", () => {
  it("ignores an undefined chunk and still assembles the real bytes", async () => {
    const packsDir = path.join(root, "coaching-packs");
    const sourcePack = path.join(root, "source-pack");
    writeCoachingPackSource(sourcePack);
    let receivedBytes: Buffer | undefined;
    const realChunk = new Uint8Array([9, 8, 7]);
    const fakeFetch = (() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // A falsy chunk value with `done: false` — defensively skipped by
          // `if (!value) { continue; }` — must contribute NOTHING to the
          // assembled buffer or its size accounting.
          controller.enqueue(undefined as unknown as Uint8Array);
          controller.enqueue(realChunk);
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;

    const outcome = await installCoachingDistribution(
      makeCoachingDistribution(),
      baseDeps({
        packsDir,
        fetch: fakeFetch,
        extractZip: (bytes, destDir) => {
          receivedBytes = Buffer.from(bytes);
          cpSync(sourcePack, destDir, { recursive: true });
        },
      })
    );

    assert.equal(outcome.status, "installed");
    assert.deepEqual(receivedBytes, Buffer.from(realChunk));
  });
});

describe("installCoachingDistribution: the temp-dir cleanup failure is logged, never thrown", () => {
  it("logs a cleanup failure without failing an otherwise-successful install", {
    skip: !PERMISSION_DENIAL_ENFORCED,
  }, async () => {
    const packsDir = path.join(root, "coaching-packs");
    const sourcePack = path.join(root, "source-pack");
    writeCoachingPackSource(sourcePack);
    const customTempDir = path.join(root, "cleanup-temp");
    mkdirSync(customTempDir, { recursive: true });
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      )) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });

    try {
      const outcome = await installCoachingDistribution(
        makeCoachingDistribution(),
        baseDeps({
          packsDir,
          fetch: fakeFetch,
          makeTempDir: () => customTempDir,
          extractZip: (_bytes, destDir) => {
            cpSync(sourcePack, destDir, { recursive: true });
          },
          installCoachingPackFromDistribution: (
            sourceDir,
            packDest,
            activate
          ) => {
            // Run the REAL install first (it still needs to read sourceDir),
            // then strip read/execute permission from the now-finished temp
            // dir so the module's own `finally`-block `rmSync` genuinely
            // fails (force: true only swallows a MISSING path, not EACCES).
            const result = installCoachingPackFromDistribution(
              sourceDir,
              packDest,
              activate
            );
            chmodSync(sourceDir, 0);
            return result;
          },
        })
      );

      assert.equal(outcome.status, "installed");
      const warnCall = warnSpy.mock.calls.find(([, message]) =>
        String(message).includes("temp cleanup failed")
      );
      assert.ok(warnCall, "the cleanup failure must be logged, not thrown");
    } finally {
      warnSpy.mockRestore();
      chmodSync(customTempDir, 0o755);
      rmSync(customTempDir, { recursive: true, force: true });
    }
  });
});
