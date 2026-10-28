/**
 * ISS-11105: the legacy-manifest heal's diagnostic when `rmSync` throws a
 * value that is not an `Error`. migrations-manifest-lib.test.ts covers the
 * `Error` arm through a real filesystem refusal; no real refusal throws a
 * non-Error, so this arm needs `rmSync` replaced.
 */
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  healLegacyManifest,
  legacyManifestPath,
} from "../scripts/generate-migrations-manifest-lib.mjs";

const rmSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, rmSync: rmSyncMock };
});

const NON_ERROR_THROWN: unknown = "EBUSY: held open";

const LEGACY_RELATIVE = path.join(
  "src",
  "main",
  "database",
  "migrations-manifest.ts"
);

describe("ISS-11105: healLegacyManifest with a non-Error throw", () => {
  it("stringifies the thrown value into the diagnostic and does not abort", () => {
    const appDir = path.join(tmpdir(), "iss-11105-heal-app");
    rmSyncMock.mockImplementationOnce(() => {
      throw NON_ERROR_THROWN;
    });
    const lines: string[] = [];

    expect(() =>
      healLegacyManifest(appDir, (line) => {
        lines.push(line);
      })
    ).not.toThrow();

    expect(rmSyncMock).toHaveBeenCalledWith(legacyManifestPath(appDir), {
      force: true,
    });
    expect(lines).toEqual([
      `generate-migrations-manifest: could not remove legacy ${LEGACY_RELATIVE} (EBUSY: held open)\n`,
    ]);
  });
});
