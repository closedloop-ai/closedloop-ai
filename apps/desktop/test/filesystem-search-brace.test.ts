import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type * as GlobModule from "glob";
import { afterEach, describe, it, vi } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  containedResults,
  registerFilesystemSearchRoutes,
} from "../src/server/operations/filesystem-search.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

/**
 * ISS-11193 — the search box is a substring match, so `{a,b}` in a query is
 * literal text. Brace expansion made it an alternation, and a run of them
 * expands into 2^n patterns synchronously on the Electron main thread.
 */

const SEARCH_ROUTE = "/api/gateway/files/search";

// Lets one case hand the route an escaped glob match, which `nobrace` means a
// real query can no longer produce. Every other case runs the real glob.
const globOverride = vi.hoisted((): { matches: string[] | null } => ({
  matches: null,
}));

vi.mock("glob", async (importOriginal) => {
  const actual = await importOriginal<typeof GlobModule>();
  return {
    ...actual,
    glob: (...args: Parameters<typeof actual.glob>) =>
      globOverride.matches
        ? Promise.resolve(globOverride.matches)
        : actual.glob(...args),
  };
});

afterEach(() => {
  globOverride.matches = null;
});

const { makeTempDir } = createGitOpTempDirs("iss11193-search-brace-");

async function searchSandbox(
  query: string
): Promise<{ statusCode: number; files: string[] }> {
  const root = makeTempDir();
  const repoDir = path.join(root, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  for (const name of ["a.txt", "b.txt", "{a,b}.txt"]) {
    await fs.writeFile(path.join(repoDir, name), "");
  }

  const dispatcher = new OperationDispatcher();
  registerFilesystemSearchRoutes(dispatcher, () => [root]);
  const response = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: SEARCH_ROUTE,
    query: { repo: repoDir, base: "true", query },
  });
  return {
    statusCode: response.statusCode,
    files: response.body.files as string[],
  };
}

describe(`GET ${SEARCH_ROUTE} — brace characters are literal`, () => {
  it("matches only the file whose name contains `{a,b}`, not a.txt or b.txt", async () => {
    const { statusCode, files } = await searchSandbox("{a,b}");

    assert.equal(statusCode, 200);
    assert.deepEqual(files, ["{a,b}.txt"]);
  });

  it("still finds a plain substring match", async () => {
    const { statusCode, files } = await searchSandbox("b.t");

    assert.equal(statusCode, 200);
    assert.deepEqual(files, ["b.txt"]);
  });
});

describe("containedResults — the layer behind nobrace", () => {
  it("is applied to the route's glob output", async () => {
    globOverride.matches = ["../outside/secret.txt", "a.txt"];

    const { statusCode, files } = await searchSandbox("txt");

    assert.equal(statusCode, 200);
    assert.deepEqual(files, ["a.txt"]);
  });

  it("drops a match that resolves outside the search root", () => {
    const root = makeTempDir();

    assert.deepEqual(
      containedResults(root, ["../outside/secret.txt", "in.txt", "a/../b.txt"]),
      ["in.txt", "a/../b.txt"]
    );
  });
});
