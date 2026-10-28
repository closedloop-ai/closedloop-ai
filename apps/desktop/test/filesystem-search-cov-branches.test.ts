/**
 * ISS-11282: branch coverage for the gateway file-search route
 * (`src/server/operations/filesystem-search.ts`). Pins the protected-root
 * exclusion when the search root IS a TCC folder, the rethrow arms of both
 * path checks, and the non-Error 500 message, plus the relevance sort over a
 * real directory walk. Walk-order independence is pinned with a mocked glob
 * in filesystem-search-cov-relevance-order.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerFilesystemSearchRoutes } from "../src/server/operations/filesystem-search.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

const SEARCH_PATH = "/api/gateway/files/search";
// Typed unknown so the case exercises the non-Error catch arm.
const NON_ERROR_FAILURE: unknown = "plain string failure";

const { makeTempDir } = createGitOpTempDirs("iss11282-fs-search-");

afterEach(() => {
  vi.restoreAllMocks();
});

function search(
  getAllowedDirectories: () => string[],
  query: Record<string, string>
) {
  const dispatcher = new OperationDispatcher();
  registerFilesystemSearchRoutes(dispatcher, getAllowedDirectories);
  return dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: SEARCH_PATH,
    query,
  });
}

describe("filesystem search: protected root", () => {
  it("excludes every file when the search root is itself a TCC-protected home folder", async () => {
    const home = makeTempDir();
    const musicDir = path.join(home, "Music");
    mkdirSync(musicDir, { recursive: true });
    writeFileSync(path.join(musicDir, "target.ts"), "// track");
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const res = await search(() => [musicDir], {
      repo: musicDir,
      base: "true",
      query: "target",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ files: [], truncated: false });
  });

  it("still finds files under a sibling folder that is not protected", async () => {
    const home = makeTempDir();
    const projectDir = path.join(home, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "target.ts"), "// src");
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const res = await search(() => [projectDir], {
      repo: projectDir,
      base: "true",
      query: "target",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ files: ["target.ts"], truncated: false });
  });
});

describe("filesystem search: failures from the allow-list source", () => {
  it("returns 500 with the error message when the repo allow-list read throws", async () => {
    const res = await search(
      () => {
        throw new Error("settings store offline");
      },
      { repo: makeTempDir(), base: "true" }
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      files: [],
      truncated: false,
      error: "Failed to search files: settings store offline",
    });
  });

  it("returns 500 when only the second allow-list read (the search dir check) throws", async () => {
    const repo = makeTempDir();
    let calls = 0;
    const res = await search(
      () => {
        calls += 1;
        if (calls === 1) {
          return [repo];
        }
        throw new Error("second read failed");
      },
      { repo, base: "true" }
    );

    expect(calls).toBe(2);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("Failed to search files: second read failed");
  });

  it("reports 'Unknown error' when a non-Error value is thrown", async () => {
    const res = await search(
      () => {
        throw NON_ERROR_FAILURE;
      },
      { repo: makeTempDir(), base: "true" }
    );

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("Failed to search files: Unknown error");
  });
});

describe("filesystem search: relevance order", () => {
  it("ranks exact name, then prefix, then shorter path, then locale order", async () => {
    const repo = makeTempDir();
    for (const name of [
      "zz-widget-helpers.ts",
      "a-widget.ts",
      "widgetry.ts",
      "b-widget.ts",
      "widget.ts",
      "widget-long-name.ts",
    ]) {
      writeFileSync(path.join(repo, name), "");
    }

    const res = await search(() => [repo], {
      repo,
      base: "true",
      query: "widget",
    });

    assert.equal(res.statusCode, 200);
    expect(res.body.files).toEqual([
      "widget.ts",
      "widgetry.ts",
      "widget-long-name.ts",
      "a-widget.ts",
      "b-widget.ts",
      "zz-widget-helpers.ts",
    ]);
  });

  it("ranks the exact-stem match first for an upper-case query", async () => {
    const repo = makeTempDir();
    for (const name of ["widget.tsx", "x-widget.ts", "y-widget.ts"]) {
      writeFileSync(path.join(repo, name), "");
    }

    const res = await search(() => [repo], {
      repo,
      base: "true",
      query: "WIDGET",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.files).toEqual([
      "widget.tsx",
      "x-widget.ts",
      "y-widget.ts",
    ]);
  });
});
